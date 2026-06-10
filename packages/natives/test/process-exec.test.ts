/**
 * Contract tests for `processExec` (POSIX process-image replacement backing
 * the coding-agent's `/restart` command).
 *
 * Success cannot be asserted in-process (the test runner would be replaced),
 * so the replacement contract runs in a spawned `bun -e` child: when exec
 * succeeds, the child BECOMES `echo` — its output appears and the sentinel
 * line after the call never runs. Failure contracts run in-process since a
 * failed exec returns control with an error.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { processExec } from "../native/index.js";

const POSIX = process.platform !== "win32";

describe("processExec", () => {
	it.if(POSIX)("replaces the process image; code after a successful exec never runs", async () => {
		const loader = path.resolve(import.meta.dir, "../native/index.js");
		const script = [
			`const { processExec } = await import(${JSON.stringify(loader)});`,
			`processExec(["echo", "exec-replaced-ok"]);`,
			`console.log("NOT-REPLACED");`,
		].join("\n");
		const child = Bun.spawn({ cmd: [process.execPath, "-e", script], stdout: "pipe", stderr: "pipe" });
		const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("exec-replaced-ok");
		expect(stdout).not.toContain("NOT-REPLACED");
	});

	it.if(POSIX)("returns control with an error when the target binary does not exist", () => {
		expect(() => processExec(["/nonexistent-omp-restart-target-xyz"])).toThrow(/execvp/);
	});

	it("rejects an empty argv", () => {
		expect(() => processExec([])).toThrow(/non-empty/);
	});

	it.if(!POSIX)("reports unsupported on Windows", () => {
		expect(() => processExec(["cmd.exe"])).toThrow(/not supported/);
	});
});
