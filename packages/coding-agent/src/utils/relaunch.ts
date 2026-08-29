/**
 * Boot-probe primitives for the `restart` tool.
 *
 * `selfInvocation` reconstructs how this process was started: a script entry
 * (`bun src/cli.ts`, `bun dist/cli.js`) probes through the same runtime and
 * entry module, while a compiled binary probes `process.execPath` itself, so
 * the probe always loads the exact artifact the user is iterating on (freshly
 * rebuilt source or binary) rather than whatever `omp` resolves to on PATH.
 *
 * The relaunch itself lives in `InteractiveMode.restart()`, which rewrites the
 * original launch argv (`restartArgv`) and replaces the process image through
 * `execReplace`. Nothing here performs the exec.
 */
import { isCompiledBinary } from "@oh-my-pi/pi-utils";

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
 * Boot-probe the artifact a restart would exec into by spawning
 * `<selfInvocation> --version` and requiring a clean exit. Catches builds that
 * cannot load at all (syntax errors, broken import graphs) before the running
 * process is irreversibly replaced. Does not catch state-dependent failures
 * (e.g. a session-resume crash); those remain the restart's residual risk and
 * are documented in the restart tool description.
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
