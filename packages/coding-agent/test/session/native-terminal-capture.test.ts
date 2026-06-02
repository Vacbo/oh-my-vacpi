import { describe, expect, it } from "bun:test";
import {
	captureNativeTerminal,
	detectDisplayServer,
	type NativeCaptureDeps,
	type NativeCaptureExecResult,
	parseDarwinWindows,
	parseHyprlandRect,
	parseSwayFocusedRect,
	selectWindow,
} from "@oh-my-pi/pi-coding-agent/session/native-terminal-capture";

interface DepsOverrides {
	platform?: NodeJS.Platform;
	env?: Record<string, string | undefined>;
	binaries?: Set<string>;
	exec?: (command: readonly string[]) => Promise<NativeCaptureExecResult>;
	fileSize?: number | ((filePath: string) => Promise<number>);
}

function makeDeps(overrides: DepsOverrides = {}): NativeCaptureDeps {
	const binaries = overrides.binaries ?? new Set<string>();
	const size = overrides.fileSize ?? 2048;
	return {
		platform: overrides.platform ?? "darwin",
		env: overrides.env ?? {},
		which: bin => binaries.has(bin),
		exec: overrides.exec ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" })),
		fileSize: typeof size === "function" ? size : async () => size,
	};
}

const DEST = "/tmp/omp-tui-shot.png";

describe("native terminal capture", () => {
	it("refuses when disabled", async () => {
		const outcome = await captureNativeTerminal({ enabled: false, destPath: DEST }, makeDeps());
		expect(outcome.ok).toBe(false);
		expect(outcome.ok ? null : outcome.reason).toBe("disabled");
	});

	it("reports unsupported platforms", async () => {
		const outcome = await captureNativeTerminal({ enabled: true, destPath: DEST }, makeDeps({ platform: "win32" }));
		expect(outcome.ok ? null : outcome.reason).toBe("unsupported-platform");
	});

	it("builds screencapture -x -l <windowId> <dest> after resolving a single window", async () => {
		const commands: string[][] = [];
		const deps = makeDeps({
			platform: "darwin",
			binaries: new Set(["screencapture", "osascript"]),
			exec: async command => {
				commands.push([...command]);
				if (command[0] === "osascript") {
					return {
						exitCode: 0,
						stdout: JSON.stringify([{ windowId: 42, appName: "Ghostty", title: "omp", pid: 111 }]),
						stderr: "",
					};
				}
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		const outcome = await captureNativeTerminal({ enabled: true, destPath: DEST }, deps);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.message);
		expect(outcome.result.command).toEqual(["screencapture", "-x", "-l", "42", DEST]);
		expect(outcome.result.tool).toBe("screencapture");
		expect(outcome.result.windowId).toBe("42");
		expect(outcome.result.appName).toBe("Ghostty");
	});

	it("adds -o to drop the window shadow when chrome is excluded", async () => {
		const deps = makeDeps({
			platform: "darwin",
			binaries: new Set(["screencapture", "osascript"]),
			exec: async command =>
				command[0] === "osascript"
					? {
							exitCode: 0,
							stdout: JSON.stringify([{ windowId: 7, appName: "Warp", title: "", pid: 1 }]),
							stderr: "",
						}
					: { exitCode: 0, stdout: "", stderr: "" },
		});
		const outcome = await captureNativeTerminal({ enabled: true, destPath: DEST, includeWindowChrome: false }, deps);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.message);
		expect(outcome.result.command).toEqual(["screencapture", "-x", "-o", "-l", "7", DEST]);
	});

	it("returns ambiguous-window when multiple terminals match and none is preferred", async () => {
		const deps = makeDeps({
			platform: "darwin",
			binaries: new Set(["screencapture", "osascript"]),
			exec: async () => ({
				exitCode: 0,
				stdout: JSON.stringify([
					{ windowId: 1, appName: "Ghostty", title: "a", pid: 1 },
					{ windowId: 2, appName: "iTerm2", title: "b", pid: 2 },
				]),
				stderr: "",
			}),
		});
		const outcome = await captureNativeTerminal({ enabled: true, destPath: DEST }, deps);
		expect(outcome.ok ? null : outcome.reason).toBe("ambiguous-window");
	});

	it("never falls back to full screen when no terminal window is found", async () => {
		const deps = makeDeps({
			platform: "darwin",
			binaries: new Set(["screencapture", "osascript"]),
			exec: async () => ({
				exitCode: 0,
				stdout: JSON.stringify([{ windowId: 9, appName: "Finder", title: "", pid: 5 }]),
				stderr: "",
			}),
		});
		const outcome = await captureNativeTerminal({ enabled: true, destPath: DEST }, deps);
		expect(outcome.ok ? null : outcome.reason).toBe("no-window");
	});

	it("reports no-tool when screencapture is missing", async () => {
		const outcome = await captureNativeTerminal(
			{ enabled: true, destPath: DEST },
			makeDeps({ platform: "darwin", binaries: new Set() }),
		);
		expect(outcome.ok ? null : outcome.reason).toBe("no-tool");
	});

	it("captures an X11 window with maim via the active window id", async () => {
		const commands: string[][] = [];
		const deps = makeDeps({
			platform: "linux",
			env: { DISPLAY: ":0" },
			binaries: new Set(["xdotool", "maim"]),
			exec: async command => {
				commands.push([...command]);
				if (command[0] === "xdotool" && command[1] === "getactivewindow") {
					return { exitCode: 0, stdout: "12345\n", stderr: "" };
				}
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		const outcome = await captureNativeTerminal({ enabled: true, destPath: DEST }, deps);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.message);
		expect(outcome.result.displayServer).toBe("x11");
		expect(outcome.result.command).toEqual(["maim", "-i", "12345", DEST]);
	});

	it("reports no-tool on X11 when no screenshot binary exists", async () => {
		const deps = makeDeps({
			platform: "linux",
			env: { DISPLAY: ":0" },
			binaries: new Set(["xdotool"]),
			exec: async command =>
				command[1] === "getactivewindow"
					? { exitCode: 0, stdout: "1\n", stderr: "" }
					: { exitCode: 0, stdout: "", stderr: "" },
		});
		const outcome = await captureNativeTerminal({ enabled: true, destPath: DEST }, deps);
		expect(outcome.ok ? null : outcome.reason).toBe("no-tool");
	});

	it("captures a Wayland window with grim using the sway focused rect", async () => {
		const tree = JSON.stringify({
			nodes: [{ focused: false, rect: { x: 0, y: 0, width: 10, height: 10 }, nodes: [] }],
			floating_nodes: [{ focused: true, rect: { x: 100, y: 50, width: 800, height: 600 } }],
		});
		const deps = makeDeps({
			platform: "linux",
			env: { WAYLAND_DISPLAY: "wayland-1", XDG_SESSION_TYPE: "wayland" },
			binaries: new Set(["grim", "swaymsg"]),
			exec: async command =>
				command[0] === "swaymsg"
					? { exitCode: 0, stdout: tree, stderr: "" }
					: { exitCode: 0, stdout: "", stderr: "" },
		});
		const outcome = await captureNativeTerminal({ enabled: true, destPath: DEST }, deps);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.message);
		expect(outcome.result.command).toEqual(["grim", "-g", "100,50 800x600", DEST]);
	});

	it("reports no-tool on Wayland without grim", async () => {
		const outcome = await captureNativeTerminal(
			{ enabled: true, destPath: DEST },
			makeDeps({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-1" }, binaries: new Set(["swaymsg"]) }),
		);
		expect(outcome.ok ? null : outcome.reason).toBe("no-tool");
	});

	it("reports unsupported when no display server is detected on linux", async () => {
		const outcome = await captureNativeTerminal(
			{ enabled: true, destPath: DEST },
			makeDeps({ platform: "linux", env: {} }),
		);
		expect(outcome.ok ? null : outcome.reason).toBe("unsupported-platform");
	});

	it("treats an empty capture file as a failure", async () => {
		const deps = makeDeps({
			platform: "darwin",
			binaries: new Set(["screencapture", "osascript"]),
			fileSize: 0,
			exec: async command =>
				command[0] === "osascript"
					? {
							exitCode: 0,
							stdout: JSON.stringify([{ windowId: 3, appName: "Ghostty", title: "", pid: 1 }]),
							stderr: "",
						}
					: { exitCode: 0, stdout: "", stderr: "" },
		});
		const outcome = await captureNativeTerminal({ enabled: true, destPath: DEST }, deps);
		expect(outcome.ok ? null : outcome.reason).toBe("capture-failed");
	});
});

describe("native capture parsing helpers", () => {
	it("detects display servers from session type and display vars", () => {
		expect(detectDisplayServer({ XDG_SESSION_TYPE: "wayland" })).toBe("wayland");
		expect(detectDisplayServer({ XDG_SESSION_TYPE: "x11" })).toBe("x11");
		expect(detectDisplayServer({ WAYLAND_DISPLAY: "wayland-1" })).toBe("wayland");
		expect(detectDisplayServer({ DISPLAY: ":0" })).toBe("x11");
		expect(detectDisplayServer({})).toBeNull();
	});

	it("selects terminal windows and classifies ambiguity", () => {
		const windows = [
			{ windowId: "1", appName: "Ghostty", title: "a" },
			{ windowId: "2", appName: "Finder", title: "b" },
		];
		expect(selectWindow(windows)).toEqual({ kind: "single", candidate: windows[0]! });
		expect(selectWindow(windows, "finder")).toEqual({ kind: "single", candidate: windows[1]! });
		expect(selectWindow([{ windowId: "3", appName: "Safari", title: "" }])).toEqual({ kind: "none" });
	});

	it("parses darwin window JSON, ignoring malformed entries", () => {
		const parsed = parseDarwinWindows(
			JSON.stringify([{ windowId: 5, appName: "Warp", title: "t", pid: 9 }, { appName: "no-id" }]),
		);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toEqual({ windowId: "5", appName: "Warp", title: "t", pid: 9 });
		expect(parseDarwinWindows("not json")).toEqual([]);
	});

	it("parses focused sway and hyprland geometry", () => {
		expect(parseSwayFocusedRect(JSON.stringify({ focused: true, rect: { x: 1, y: 2, width: 3, height: 4 } }))).toBe(
			"1,2 3x4",
		);
		expect(parseHyprlandRect(JSON.stringify({ at: [10, 20], size: [30, 40] }))).toBe("10,20 30x40");
		expect(parseSwayFocusedRect("{}")).toBeNull();
		expect(parseHyprlandRect("nope")).toBeNull();
	});
});
