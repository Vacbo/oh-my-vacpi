/**
 * Contracts for `selfInvocation`, which the `restart` tool's boot probe
 * (`preflightRelaunch`) and artifact report (`relaunchArtifact`) build on: the
 * probe must re-invoke the exact artifact this process runs from — runtime plus
 * script entry for source/npm runs, the binary itself for compiled runs — so a
 * broken rebuild is caught before the process image is replaced.
 *
 * The relaunch argv itself is upstream's `restartArgv` (see
 * `test/flag-tables.test.ts`), which rewrites the original launch flags rather
 * than resuming by session-file path.
 */
import { describe, expect, it } from "bun:test";
import { selfInvocation } from "@oh-my-pi/pi-coding-agent/utils/relaunch";

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
