/**
 * Self-relaunch primitives for the `/restart` command and the `restart` tool.
 *
 * `selfInvocation` reconstructs how this process was started: a script entry
 * (`bun src/cli.ts`, `bun dist/cli.js`) relaunches through the same runtime
 * and entry module, while a compiled binary relaunches `process.execPath`
 * itself, so a restart always loads the exact artifact the user is iterating
 * on (freshly rebuilt source or binary) rather than whatever `omp` resolves
 * to on PATH.
 */
import { processExec } from "@oh-my-pi/pi-natives";
import { isCompiledBinary, logger } from "@oh-my-pi/pi-utils";

/** Argv tail that resumes the given session file, or none for unpersisted sessions.
 *  A `followUpMessage` rides along as a positional argument: `runInteractiveMode`
 *  auto-submits positionals after resume (`initialMessages`), which is how the
 *  restart tool's confirmation reaches the model in the relaunched process. */
export function buildRestartArgs(sessionFile: string | undefined, followUpMessage?: string): string[] {
	// Resume by exact file path: immune to cwd moves and --session-dir
	// resolution, and `createSessionManager` opens path-like arguments
	// directly without directory scanning.
	if (!sessionFile) {
		// No session to resume: drop the follow-up too. A fresh session must
		// not receive a stray auto-submitted prompt.
		return [];
	}
	const args = ["--resume", sessionFile];
	if (followUpMessage) {
		args.push(followUpMessage);
	}
	return args;
}

export function selfInvocation(
	entry: string | undefined = process.argv[1],
	execPath: string = process.execPath,
	compiled: boolean = isCompiledBinary(),
): string[] {
	// Compiled binaries embed their entry (argv[1] is a bunfs path, or the
	// first user argument); the binary itself is the whole invocation.
	if (compiled) {
		return [execPath];
	}
	if (entry && (entry.endsWith(".ts") || entry.endsWith(".js"))) {
		return [execPath, entry];
	}
	return [execPath];
}

/** The filesystem artifact a relaunch would load: the entry script when
 *  running from source (`bun src/cli.ts`), the compiled binary otherwise. */
export function relaunchArtifact(): string {
	const invocation = selfInvocation();
	return invocation[invocation.length - 1];
}

export interface RelaunchPreflight {
	ok: boolean;
	/** Trimmed `--version` stdout when the probe succeeded. */
	version?: string;
	/** Failure detail: exit code plus stderr tail, timeout note, or spawn error. */
	detail?: string;
}

/**
 * Boot-probe the exact artifact {@link relaunchSelf} would exec into by
 * spawning `<selfInvocation> --version` and requiring a clean exit. Catches
 * builds that cannot load at all (syntax errors, broken import graphs) before
 * the running process is irreversibly replaced. Does not catch state-dependent
 * failures (e.g. a session-resume crash); those remain the restart's residual
 * risk and are documented in the restart tool description.
 */
export async function preflightRelaunch(timeoutMs = 15_000): Promise<RelaunchPreflight> {
	const argv = [...selfInvocation(), "--version"];
	let timedOut = false;
	try {
		const child = Bun.spawn({ cmd: argv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout as ReadableStream<Uint8Array>).text(),
			new Response(child.stderr as ReadableStream<Uint8Array>).text(),
		]);
		clearTimeout(timer);
		if (exitCode === 0) {
			return { ok: true, version: stdout.trim() };
		}
		if (timedOut) {
			return { ok: false, detail: `boot probe timed out after ${timeoutMs}ms` };
		}
		const stderrTail = stderr.trim().slice(-500);
		return { ok: false, detail: `exit ${exitCode}${stderrTail ? `: ${stderrTail}` : ""}` };
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Replace this process with a fresh self-invocation.
 *
 * POSIX: true `execvp`, so the pid, controlling terminal, and foreground
 * process-group state carry over and no dormant parent is left behind.
 * Windows (or a failed exec): spawn-and-wait fallback; resolves with the
 * child's exit code for the caller to exit with. The caller must have fully
 * torn down the TUI (cooked terminal mode) and run postmortem cleanup first.
 */
export async function relaunchSelf(args: string[]): Promise<number> {
	const argv = [...selfInvocation(), ...args];
	if (process.platform !== "win32") {
		try {
			processExec(argv);
		} catch (err) {
			logger.warn("processExec failed; falling back to spawn-and-wait", { argv, error: String(err) });
		}
	}
	// Fallback: the child shares this terminal's foreground process group, so
	// Ctrl+C reaches it directly; the parent must ignore the signal to avoid
	// dying (and yielding the tty back to the shell) before the child exits.
	const ignoreSignal = () => {};
	process.on("SIGINT", ignoreSignal);
	process.on("SIGTERM", ignoreSignal);
	const child = Bun.spawn({ cmd: argv, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	return await child.exited;
}
