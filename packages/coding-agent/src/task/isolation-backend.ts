export type TaskIsolationMode = "none" | "worktree" | "fuse-overlay" | "fuse-projfs";

export interface IsolationBackendResolution {
	effectiveIsolationMode: TaskIsolationMode;
	warning: string;
}

type ProcessorEnv = Partial<Pick<NodeJS.ProcessEnv, "PROCESSOR_ARCHITECTURE" | "PROCESSOR_ARCHITEW6432">>;

function isWindowsArm64HostUnderX64Emulation(
	platform: NodeJS.Platform,
	arch: NodeJS.Architecture,
	env: ProcessorEnv,
): boolean {
	if (platform !== "win32" || arch !== "x64") return false;
	return (
		env.PROCESSOR_ARCHITECTURE?.toUpperCase() === "ARM64" || env.PROCESSOR_ARCHITEW6432?.toUpperCase() === "ARM64"
	);
}

export async function resolveIsolationBackendForTaskExecution(
	requestedMode: TaskIsolationMode,
	isIsolated: boolean,
	repoRoot: string | null,
	platform: NodeJS.Platform = process.platform,
	arch: NodeJS.Architecture = process.arch,
	env: ProcessorEnv = process.env as ProcessorEnv,
): Promise<IsolationBackendResolution> {
	let effectiveIsolationMode = requestedMode;
	let warning = "";
	if (!(isIsolated && repoRoot)) {
		return { effectiveIsolationMode, warning };
	}

	if (requestedMode === "fuse-overlay" && platform === "win32") {
		effectiveIsolationMode = "worktree";
		warning =
			'<system-notification>fuse-overlay isolation is unavailable on Windows. Use task.isolation.mode = "fuse-projfs" for ProjFS. Falling back to worktree isolation.</system-notification>';
		return { effectiveIsolationMode, warning };
	}

	if (requestedMode === "fuse-projfs" && platform !== "win32") {
		effectiveIsolationMode = "worktree";
		warning =
			"<system-notification>fuse-projfs isolation is only available on Windows. Falling back to worktree isolation.</system-notification>";
		return { effectiveIsolationMode, warning };
	}

	if (requestedMode === "fuse-projfs" && isWindowsArm64HostUnderX64Emulation(platform, arch, env)) {
		effectiveIsolationMode = "worktree";
		warning =
			"<system-notification>ProjFS isolation is disabled on Windows ARM64 x64 emulation. Falling back to worktree isolation.</system-notification>";
	}

	return { effectiveIsolationMode, warning };
}
