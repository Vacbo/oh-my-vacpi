import { describe, expect, it } from "bun:test";
import {
	detectTerminalEagerEraseScrollbackRisk,
	shouldEnableSynchronizedOutputByDefault,
} from "@oh-my-pi/pi-tui/terminal-capabilities";

describe("terminal capability defaults", () => {
	it("treats SSH-stripped Linux truecolor sessions as ED3-risk", () => {
		expect(
			detectTerminalEagerEraseScrollbackRisk(
				{ TERM: "xterm-256color", COLORTERM: "truecolor", SSH_TTY: "/dev/pts/3" },
				"linux",
			),
		).toBe(true);
	});

	it("treats Ptyxis and unknown POSIX terminals as ED3-risk by default", () => {
		expect(detectTerminalEagerEraseScrollbackRisk({ TERM_PROGRAM: "ptyxis" }, "linux")).toBe(true);
		expect(detectTerminalEagerEraseScrollbackRisk({ TERM: "xterm-256color" }, "linux")).toBe(true);
	});

	it("keeps native win32 on the dedicated ConPTY deferral path", () => {
		expect(detectTerminalEagerEraseScrollbackRisk({ WT_SESSION: "abc" }, "win32")).toBe(false);
	});

	it("disables synchronized output by default for remote, VTE, and unknown profiles", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ SSH_CONNECTION: "1 2 3 4" }, "linux", "base")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({ VTE_VERSION: "6800" }, "linux", "base")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({ TERM: "xterm-256color" }, "linux", "base")).toBe(false);
	});

	it("allows explicit synchronized-output force-on for diagnostics", () => {
		expect(
			shouldEnableSynchronizedOutputByDefault(
				{ PI_FORCE_SYNC_OUTPUT: "1", SSH_CONNECTION: "1 2 3 4" },
				"linux",
				"base",
			),
		).toBe(true);
	});

	it("enables synchronized output by default on Warp (supports DEC 2026)", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ TERM_PROGRAM: "WarpTerminal" }, "darwin", "base")).toBe(true);
		// A multiplexer wrapping Warp still wins (screen-coordinate batching is unsafe through it).
		expect(
			shouldEnableSynchronizedOutputByDefault({ TERM_PROGRAM: "WarpTerminal", TMUX: "/tmp/x" }, "darwin", "base"),
		).toBe(false);
		// The explicit kill switch still wins.
		expect(
			shouldEnableSynchronizedOutputByDefault(
				{ TERM_PROGRAM: "WarpTerminal", PI_NO_SYNC_OUTPUT: "1" },
				"darwin",
				"base",
			),
		).toBe(false);
	});
});
