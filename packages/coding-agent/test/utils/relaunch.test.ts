/**
 * Contracts for the `/restart` relaunch argv builders: the restart must
 * re-invoke the exact artifact this process runs from (runtime + script entry
 * for source/npm runs, the binary itself for compiled runs) and resume by
 * exact session file path, which `createSessionManager` opens directly
 * without directory resolution.
 */
import { describe, expect, it } from "bun:test";
import { buildRestartArgs, selfInvocation } from "@oh-my-pi/pi-coding-agent/utils/relaunch";

describe("selfInvocation", () => {
	it("relaunches through the runtime and script entry for source runs", () => {
		expect(selfInvocation("/repo/packages/coding-agent/src/cli.ts", "/usr/bin/bun", false)).toEqual([
			"/usr/bin/bun",
			"/repo/packages/coding-agent/src/cli.ts",
		]);
	});

	it("relaunches through the runtime and bundle entry for npm runs", () => {
		expect(selfInvocation("/lib/omp/dist/cli.js", "/usr/bin/bun", false)).toEqual([
			"/usr/bin/bun",
			"/lib/omp/dist/cli.js",
		]);
	});

	it("relaunches the binary itself for compiled runs, ignoring argv[1]", () => {
		// In a compiled binary argv[1] can be a bunfs entry or the first user
		// argument ("--resume"); neither may leak into the relaunch argv.
		expect(selfInvocation("/$bunfs/root/cli.js", "/usr/local/bin/omp", true)).toEqual(["/usr/local/bin/omp"]);
		expect(selfInvocation("--resume", "/usr/local/bin/omp", true)).toEqual(["/usr/local/bin/omp"]);
	});

	it("falls back to the bare exec path when the entry is not a script", () => {
		expect(selfInvocation("serve", "/usr/local/bin/omp", false)).toEqual(["/usr/local/bin/omp"]);
	});
});

describe("buildRestartArgs", () => {
	it("resumes by exact session file path", () => {
		expect(buildRestartArgs("/home/u/.omp/sessions/abc/rollout.jsonl")).toEqual([
			"--resume",
			"/home/u/.omp/sessions/abc/rollout.jsonl",
		]);
	});
	it("appends a follow-up message only when resuming a persisted session", () => {
		expect(buildRestartArgs("/home/u/.omp/sessions/abc/rollout.jsonl", "Restart completed")).toEqual([
			"--resume",
			"/home/u/.omp/sessions/abc/rollout.jsonl",
			"Restart completed",
		]);
		expect(buildRestartArgs(undefined, "Restart completed")).toEqual([]);
	});

	it("relaunches fresh when the session is not persisted", () => {
		expect(buildRestartArgs(undefined)).toEqual([]);
	});
});
