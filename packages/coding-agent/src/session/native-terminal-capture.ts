import * as fs from "node:fs/promises";
import { $which } from "@oh-my-pi/pi-utils";

/**
 * Native terminal-window screenshot capture.
 *
 * Privacy-sensitive power-user feature: it reaches outside the OMP process to
 * photograph the actual terminal window the user sees. It is disabled by
 * default (gated by `tui.nativeCapture.enabled`) and NEVER falls back to a
 * full-screen capture — when a specific window cannot be resolved it returns a
 * typed failure instead.
 *
 * Every external dependency (platform, env, binary lookup, command execution,
 * file size) is injectable so the orchestration, strategy selection, and
 * command construction are deterministically testable without a live GUI.
 */

export type NativeCapturePlatform = "darwin" | "linux";
export type NativeCaptureDisplayServer = "x11" | "wayland";

export interface NativeCaptureResult {
	source: "native-terminal";
	platform: NativeCapturePlatform;
	displayServer?: NativeCaptureDisplayServer;
	path: string;
	mimeType: "image/png";
	bytes: number;
	tool: string;
	command: string[];
	appName?: string;
	windowTitle?: string;
	windowId?: string;
	pid?: number;
}

export type NativeCaptureFailureReason =
	| "disabled"
	| "unsupported-platform"
	| "no-window"
	| "ambiguous-window"
	| "no-tool"
	| "capture-failed";

export interface NativeCaptureSuccess {
	ok: true;
	result: NativeCaptureResult;
}

export interface NativeCaptureFailure {
	ok: false;
	reason: NativeCaptureFailureReason;
	message: string;
}

export type NativeCaptureOutcome = NativeCaptureSuccess | NativeCaptureFailure;

export interface NativeCaptureRequest {
	enabled: boolean;
	destPath: string;
	preferredApp?: string;
	includeWindowChrome?: boolean;
	pid?: number;
}

export interface NativeCaptureExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface NativeCaptureDeps {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	which(bin: string): Promise<boolean> | boolean;
	exec(command: readonly string[]): Promise<NativeCaptureExecResult>;
	fileSize(filePath: string): Promise<number>;
}

export interface WindowCandidate {
	windowId: string;
	appName: string;
	title: string;
	pid?: number;
}

export type WindowSelection =
	| { kind: "single"; candidate: WindowCandidate }
	| { kind: "ambiguous"; candidates: WindowCandidate[] }
	| { kind: "none" };

const STDERR_PREVIEW = 200;

const TERMINAL_APP_HINTS = [
	"ghostty",
	"warp",
	"terminal",
	"iterm",
	"alacritty",
	"kitty",
	"wezterm",
	"hyper",
	"tabby",
	"rio",
	"konsole",
	"foot",
	"contour",
];

// JXA enumerates on-screen, normal-layer windows via CoreGraphics and prints a
// JSON array of { windowId, appName, title, pid }. CGWindowNumber is the id
// screencapture -l expects. Window titles require Screen Recording permission;
// owner names do not, so selection works on app name alone when titles are empty.
const DARWIN_WINDOW_SCRIPT = `ObjC.import('CoreGraphics');
const info = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
const windows = ObjC.deepUnwrap(info) || [];
const out = [];
for (const w of windows) {
  if (w.kCGWindowLayer !== 0) continue;
  out.push({
    windowId: String(w.kCGWindowNumber),
    appName: w.kCGWindowOwnerName || '',
    title: w.kCGWindowName || '',
    pid: w.kCGWindowOwnerPID,
  });
}
JSON.stringify(out);`;

export function defaultNativeCaptureDeps(): NativeCaptureDeps {
	return {
		platform: process.platform,
		env: { ...process.env },
		which: bin => $which(bin) !== null,
		async exec(command) {
			const proc = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
				new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
			]);
			const exitCode = await proc.exited;
			return { exitCode, stdout, stderr };
		},
		async fileSize(filePath) {
			try {
				return (await fs.stat(filePath)).size;
			} catch {
				return 0;
			}
		},
	};
}

export async function captureNativeTerminal(
	request: NativeCaptureRequest,
	deps: NativeCaptureDeps = defaultNativeCaptureDeps(),
): Promise<NativeCaptureOutcome> {
	if (!request.enabled) {
		return fail(
			"disabled",
			"Native terminal capture is disabled. Set tui.nativeCapture.enabled to true to allow it.",
		);
	}
	if (deps.platform === "darwin") return await captureDarwin(request, deps);
	if (deps.platform === "linux") return await captureLinux(request, deps);
	return fail("unsupported-platform", `Native terminal capture is not supported on platform "${deps.platform}".`);
}

// ── macOS ──────────────────────────────────────────────────────────────────

async function captureDarwin(request: NativeCaptureRequest, deps: NativeCaptureDeps): Promise<NativeCaptureOutcome> {
	if (!(await deps.which("screencapture"))) {
		return fail("no-tool", "macOS screencapture binary was not found on PATH.");
	}
	const candidates = await enumerateDarwinWindows(deps);
	const selection = selectWindow(candidates, request.preferredApp);
	if (selection.kind === "none") {
		return fail("no-window", darwinNoWindowMessage(request.preferredApp));
	}
	if (selection.kind === "ambiguous") {
		return fail("ambiguous-window", ambiguousMessage(selection.candidates));
	}
	const window = selection.candidate;
	const command = buildDarwinCommand(window.windowId, request.destPath, request.includeWindowChrome !== false);
	const exec = await deps.exec(command);
	if (exec.exitCode !== 0) {
		return fail("capture-failed", `screencapture exited ${exec.exitCode}: ${preview(exec.stderr)}`);
	}
	const bytes = await deps.fileSize(request.destPath);
	if (bytes <= 0) {
		return fail(
			"capture-failed",
			"screencapture produced an empty file; grant Screen Recording permission and retry.",
		);
	}
	return ok({
		source: "native-terminal",
		platform: "darwin",
		path: request.destPath,
		mimeType: "image/png",
		bytes,
		tool: "screencapture",
		command,
		appName: window.appName,
		windowTitle: window.title || undefined,
		windowId: window.windowId,
		pid: window.pid,
	});
}

/** Build `screencapture` args for a known window id. `-o` drops the window shadow. */
export function buildDarwinCommand(windowId: string, destPath: string, includeWindowChrome: boolean): string[] {
	const command = ["screencapture", "-x"];
	if (!includeWindowChrome) command.push("-o");
	command.push("-l", windowId, destPath);
	return command;
}

async function enumerateDarwinWindows(deps: NativeCaptureDeps): Promise<WindowCandidate[]> {
	try {
		const exec = await deps.exec(["osascript", "-l", "JavaScript", "-e", DARWIN_WINDOW_SCRIPT]);
		if (exec.exitCode !== 0) return [];
		return parseDarwinWindows(exec.stdout);
	} catch {
		return [];
	}
}

export function parseDarwinWindows(stdout: string): WindowCandidate[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const candidates: WindowCandidate[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as { windowId?: unknown; appName?: unknown; title?: unknown; pid?: unknown };
		if (record.windowId === undefined || record.windowId === null) continue;
		candidates.push({
			windowId: String(record.windowId),
			appName: typeof record.appName === "string" ? record.appName : "",
			title: typeof record.title === "string" ? record.title : "",
			pid: typeof record.pid === "number" ? record.pid : undefined,
		});
	}
	return candidates;
}

/** Narrow candidates to the requested terminal app (or known terminals) and classify ambiguity. */
export function selectWindow(candidates: WindowCandidate[], preferredApp?: string): WindowSelection {
	const needle = preferredApp?.trim().toLowerCase();
	const matches = candidates.filter(candidate => {
		const appName = candidate.appName.toLowerCase();
		if (needle) return appName.includes(needle);
		return TERMINAL_APP_HINTS.some(hint => appName.includes(hint));
	});
	if (matches.length === 0) return { kind: "none" };
	if (matches.length === 1) return { kind: "single", candidate: matches[0]! };
	return { kind: "ambiguous", candidates: matches };
}

function darwinNoWindowMessage(preferredApp?: string): string {
	if (preferredApp) {
		return `No on-screen window owned by "${preferredApp}" was found. Check the app name and that OMP has Screen Recording permission.`;
	}
	return "No terminal window was resolved. Set tui.nativeCapture.preferredApp (e.g. Ghostty, Warp, iTerm) and grant Screen Recording permission.";
}

// ── Linux ──────────────────────────────────────────────────────────────────

async function captureLinux(request: NativeCaptureRequest, deps: NativeCaptureDeps): Promise<NativeCaptureOutcome> {
	const server = detectDisplayServer(deps.env);
	if (server === "wayland") return await captureWayland(request, deps);
	if (server === "x11") return await captureX11(request, deps);
	return fail("unsupported-platform", "No X11 (DISPLAY) or Wayland (WAYLAND_DISPLAY) session was detected.");
}

export function detectDisplayServer(env: Record<string, string | undefined>): NativeCaptureDisplayServer | null {
	const sessionType = (env.XDG_SESSION_TYPE ?? "").toLowerCase();
	if (sessionType === "wayland") return "wayland";
	if (sessionType === "x11") return "x11";
	if (env.WAYLAND_DISPLAY) return "wayland";
	if (env.DISPLAY) return "x11";
	return null;
}

interface X11Tool {
	bin: string;
	build(windowId: string, destPath: string): string[];
}

const X11_TOOLS: X11Tool[] = [
	{ bin: "maim", build: (windowId, destPath) => ["maim", "-i", windowId, destPath] },
	{ bin: "import", build: (windowId, destPath) => ["import", "-window", windowId, destPath] },
];

async function captureX11(request: NativeCaptureRequest, deps: NativeCaptureDeps): Promise<NativeCaptureOutcome> {
	const windowId = await resolveX11WindowId(request, deps);
	if (!windowId) {
		return fail(
			"no-window",
			"Could not resolve an X11 terminal window. Install xdotool, or set tui.nativeCapture.preferredApp to the window class.",
		);
	}
	let tool: X11Tool | undefined;
	for (const candidate of X11_TOOLS) {
		if (await deps.which(candidate.bin)) {
			tool = candidate;
			break;
		}
	}
	if (!tool) {
		return fail("no-tool", "No X11 window screenshot tool found. Install maim or imagemagick (import).");
	}
	const command = tool.build(windowId, request.destPath);
	const exec = await deps.exec(command);
	if (exec.exitCode !== 0) {
		return fail("capture-failed", `${tool.bin} exited ${exec.exitCode}: ${preview(exec.stderr)}`);
	}
	const bytes = await deps.fileSize(request.destPath);
	if (bytes <= 0) return fail("capture-failed", `${tool.bin} produced an empty file.`);
	return ok({
		source: "native-terminal",
		platform: "linux",
		displayServer: "x11",
		path: request.destPath,
		mimeType: "image/png",
		bytes,
		tool: tool.bin,
		command,
		windowId,
		pid: request.pid,
	});
}

async function resolveX11WindowId(request: NativeCaptureRequest, deps: NativeCaptureDeps): Promise<string | null> {
	if (!(await deps.which("xdotool"))) return null;
	if (request.preferredApp) {
		const search = await deps.exec(["xdotool", "search", "--class", request.preferredApp]);
		const id = firstLine(search.stdout);
		if (id) return id;
	}
	const active = await deps.exec(["xdotool", "getactivewindow"]);
	return firstLine(active.stdout) || null;
}

async function captureWayland(request: NativeCaptureRequest, deps: NativeCaptureDeps): Promise<NativeCaptureOutcome> {
	if (!(await deps.which("grim"))) {
		return fail("no-tool", "Wayland native capture requires grim.");
	}
	const geometry = await resolveWaylandGeometry(deps);
	if (!geometry) {
		return fail(
			"no-window",
			"Could not resolve the focused Wayland window geometry. Requires sway (swaymsg) or hyprland (hyprctl); Wayland does not expose arbitrary window targeting.",
		);
	}
	const command = ["grim", "-g", geometry, request.destPath];
	const exec = await deps.exec(command);
	if (exec.exitCode !== 0) {
		return fail("capture-failed", `grim exited ${exec.exitCode}: ${preview(exec.stderr)}`);
	}
	const bytes = await deps.fileSize(request.destPath);
	if (bytes <= 0) return fail("capture-failed", "grim produced an empty file.");
	return ok({
		source: "native-terminal",
		platform: "linux",
		displayServer: "wayland",
		path: request.destPath,
		mimeType: "image/png",
		bytes,
		tool: "grim",
		command,
		pid: request.pid,
	});
}

async function resolveWaylandGeometry(deps: NativeCaptureDeps): Promise<string | null> {
	if (await deps.which("swaymsg")) {
		const tree = await deps.exec(["swaymsg", "-t", "get_tree"]);
		const rect = parseSwayFocusedRect(tree.stdout);
		if (rect) return rect;
	}
	if (await deps.which("hyprctl")) {
		const active = await deps.exec(["hyprctl", "activewindow", "-j"]);
		const rect = parseHyprlandRect(active.stdout);
		if (rect) return rect;
	}
	return null;
}

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Find the focused node's rect in a `swaymsg -t get_tree` JSON dump → "x,y wxh". */
export function parseSwayFocusedRect(stdout: string): string | null {
	let tree: unknown;
	try {
		tree = JSON.parse(stdout);
	} catch {
		return null;
	}
	const rect = findSwayFocusedRect(tree);
	return rect ? geometryString(rect) : null;
}

function findSwayFocusedRect(node: unknown): Rect | null {
	if (!node || typeof node !== "object") return null;
	const record = node as { focused?: unknown; rect?: unknown; nodes?: unknown; floating_nodes?: unknown };
	if (record.focused === true && isRect(record.rect)) return record.rect;
	for (const key of ["nodes", "floating_nodes"] as const) {
		const children = record[key];
		if (!Array.isArray(children)) continue;
		for (const child of children) {
			const found = findSwayFocusedRect(child);
			if (found) return found;
		}
	}
	return null;
}

/** Parse `hyprctl activewindow -j` JSON ({ at: [x,y], size: [w,h] }) → "x,y wxh". */
export function parseHyprlandRect(stdout: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as { at?: unknown; size?: unknown };
	if (!isNumberPair(record.at) || !isNumberPair(record.size)) return null;
	return geometryString({ x: record.at[0], y: record.at[1], width: record.size[0], height: record.size[1] });
}

function geometryString(rect: Rect): string {
	return `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
}

function isRect(value: unknown): value is Rect {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.x === "number" &&
		typeof record.y === "number" &&
		typeof record.width === "number" &&
		typeof record.height === "number"
	);
}

function isNumberPair(value: unknown): value is [number, number] {
	return Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number";
}

// ── shared helpers ───────────────────────────────────────────────────────────

function ambiguousMessage(candidates: WindowCandidate[]): string {
	const listed = candidates
		.slice(0, 6)
		.map(candidate => `${candidate.appName}${candidate.title ? ` (${candidate.title})` : ""}`)
		.join(", ");
	return `Multiple terminal windows matched: ${listed}. Set tui.nativeCapture.preferredApp to disambiguate.`;
}

function firstLine(text: string): string | null {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return null;
}

function preview(text: string): string {
	const trimmed = text.trim().replace(/\s+/gu, " ");
	return trimmed.length > STDERR_PREVIEW ? `${trimmed.slice(0, STDERR_PREVIEW)}…` : trimmed;
}

function ok(result: NativeCaptureResult): NativeCaptureSuccess {
	return { ok: true, result };
}

function fail(reason: NativeCaptureFailureReason, message: string): NativeCaptureFailure {
	return { ok: false, reason, message };
}
