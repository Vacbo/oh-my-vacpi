import { describe, expect, it } from "bun:test";
import {
	type CmuxCaptureDeps,
	cmuxSurfaceIdFor,
	diffRenderedText,
	readCmuxScreen,
} from "@oh-my-pi/pi-coding-agent/session/cmux-capture";

interface DepsOverrides {
	env?: Record<string, string | undefined>;
	binaries?: Record<string, true>;
	exec?: (command: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

function makeDeps(overrides: DepsOverrides = {}): CmuxCaptureDeps {
	const binaries = overrides.binaries ?? { cmux: true };
	return {
		env: overrides.env ?? {},
		which: bin => binaries[bin] === true,
		exec: overrides.exec ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" })),
	};
}

describe("readCmuxScreen", () => {
	it("reads the viewport and strips the trailing newline", async () => {
		const commands: string[][] = [];
		const deps = makeDeps({
			exec: async command => {
				commands.push([...command]);
				return { exitCode: 0, stdout: "row one\nrow two\n", stderr: "" };
			},
		});
		const outcome = await readCmuxScreen({ surfaceId: "surface-1" }, deps);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.message);
		expect(commands).toEqual([["cmux", "read-screen", "--surface", "surface-1"]]);
		expect(outcome.result.text).toBe("row one\nrow two");
	});

	it("passes --lines and honors the CMUX_OMP_CMUX_BIN override", async () => {
		const commands: string[][] = [];
		const deps = makeDeps({
			env: { CMUX_OMP_CMUX_BIN: "cmux-dev" },
			binaries: { "cmux-dev": true },
			exec: async command => {
				commands.push([...command]);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		const outcome = await readCmuxScreen({ surfaceId: "surface-1", lines: 80 }, deps);
		expect(outcome.ok).toBe(true);
		expect(commands).toEqual([["cmux-dev", "read-screen", "--surface", "surface-1", "--lines", "80"]]);
	});

	it("fails typed when cmux is missing or read-screen errors", async () => {
		const missing = await readCmuxScreen({ surfaceId: "s" }, makeDeps({ binaries: {} }));
		expect(missing.ok ? null : missing.reason).toBe("no-cmux");

		const failed = await readCmuxScreen(
			{ surfaceId: "s" },
			makeDeps({ exec: async () => ({ exitCode: 1, stdout: "", stderr: "unknown surface" }) }),
		);
		expect(failed.ok ? null : failed.reason).toBe("read-failed");
		expect(failed.ok ? "" : failed.message).toContain("unknown surface");
	});
});

describe("cmuxSurfaceIdFor", () => {
	it("prefers the surface recorded at registration", () => {
		const session = { pid: process.pid, cmuxSurfaceId: "recorded" };
		expect(cmuxSurfaceIdFor(session, { CMUX_SURFACE_ID: "from-env" })).toBe("recorded");
	});

	it("falls back to the current process's environment, but never for other processes", () => {
		const env = { CMUX_SURFACE_ID: "from-env" };
		expect(cmuxSurfaceIdFor({ pid: process.pid }, env)).toBe("from-env");
		expect(cmuxSurfaceIdFor({ pid: process.pid + 1 }, env)).toBeUndefined();
	});
});

describe("diffRenderedText", () => {
	it("treats trailing whitespace and trailing blank rows as padding, not content", () => {
		const diff = diffRenderedText("alpha  \nbeta\n\n\n", "alpha\nbeta   ");
		expect(diff.identical).toBe(true);
		expect(diff.rowsCompared).toBe(2);
		expect(diff.matchedRows).toBe(2);
		expect(diff.internalRows).toBe(2);
		expect(diff.emulatorRows).toBe(2);
	});

	it("localizes mismatches to their row and keeps both sides", () => {
		const diff = diffRenderedText("header\nstatus: ok\nfooter", "header\nstatus: ERR\nfooter");
		expect(diff.identical).toBe(false);
		expect(diff.matchedRows).toBe(2);
		expect(diff.mismatches).toEqual([{ row: 1, internal: "status: ok", emulator: "status: ERR" }]);
	});

	it("compares size skew against empty rows instead of clipping", () => {
		const diff = diffRenderedText("only row", "only row\nextra emulator row");
		expect(diff.rowsCompared).toBe(2);
		expect(diff.internalRows).toBe(1);
		expect(diff.emulatorRows).toBe(2);
		expect(diff.mismatches).toEqual([{ row: 1, internal: "", emulator: "extra emulator row" }]);
	});

	it("reports a pure scroll as scrollOffset instead of a wall of mismatches", () => {
		const internal = "alpha\nbravo\ncharlie\ndelta\necho";
		const emulator = "charlie\ndelta\necho\nfoxtrot\ngolf";
		const diff = diffRenderedText(internal, emulator);
		expect(diff.scrollOffset).toBe(2);
		// identical stays strict: it means "same screen with no scroll at all".
		expect(diff.identical).toBe(false);
		expect(diff.rowsCompared).toBe(3);
		expect(diff.matchedRows).toBe(3);
		expect(diff.mismatches).toEqual([]);
	});

	it("still localizes real mismatches inside a scrolled overlap", () => {
		const internal = "alpha\nbravo\ncharlie\ndelta";
		const emulator = "bravo\nCHANGED\ndelta\nnew row";
		const diff = diffRenderedText(internal, emulator);
		expect(diff.scrollOffset).toBe(1);
		expect(diff.mismatches).toEqual([{ row: 1, internal: "charlie", emulator: "CHANGED" }]);
	});
});
