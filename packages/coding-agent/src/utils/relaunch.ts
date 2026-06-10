/**
 * Self-relaunch primitives for the `/restart` command.
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

/** Argv tail that resumes the given session file, or none for unpersisted sessions. */
export function buildRestartArgs(sessionFile: string | undefined): string[] {
	// Resume by exact file path: immune to cwd moves and --session-dir
	// resolution, and `createSessionManager` opens path-like arguments
	// directly without directory scanning.
	return sessionFile ? ["--resume", sessionFile] : [];
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
