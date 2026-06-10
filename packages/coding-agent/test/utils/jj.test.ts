import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as jj from "@oh-my-pi/pi-coding-agent/utils/jj";
import { $which } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

describe("jj workspace detection", () => {
	let tmpDir: string | undefined;

	afterEach(async () => {
		jj.repo.clearRootCache();
		if (tmpDir) {
			await fs.rm(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	async function createTempDir(): Promise<string> {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-jj-utils-"));
		return tmpDir;
	}

	it("finds JJ workspace metadata from a nested cwd", async () => {
		const dir = await createTempDir();
		const nested = path.join(dir, "packages", "coding-agent");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await fs.mkdir(nested, { recursive: true });

		expect(await jj.repo.root(nested)).toBe(dir);
		expect(await jj.repo.is(nested)).toBe(true);
	});

	it("caches each requested cwd to its resolved workspace root", async () => {
		const dir = await createTempDir();
		const nested = path.join(dir, "src", "feature");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await fs.mkdir(nested, { recursive: true });

		expect(await jj.repo.root(nested)).toBe(dir);
		await fs.rm(path.join(dir, ".jj"), { recursive: true, force: true });

		expect(await jj.repo.root(nested)).toBe(dir);
		expect(await jj.repo.root(path.join(dir, "src"))).toBeNull();
	});

	it("does not treat a bare .jj directory as a workspace", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, ".jj"), { recursive: true });

		expect(await jj.repo.root(dir)).toBeNull();
		expect(await jj.repo.is(dir)).toBe(false);
	});

	it("detects a non-default workspace whose .jj/repo is a file", async () => {
		const dir = await createTempDir();
		const secondary = path.join(dir, "ws2");
		// Default workspace: `.jj/repo/` is a directory containing the store.
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		// `jj workspace add` workspace: `.jj/repo` is a FILE pointing — relative to
		// `.jj` — at the shared repo dir of the default workspace.
		await fs.mkdir(path.join(secondary, ".jj", "working_copy"), { recursive: true });
		await fs.writeFile(path.join(secondary, ".jj", "repo"), path.join("..", "..", ".jj", "repo"));

		expect(await jj.repo.is(secondary)).toBe(true);
		expect(await jj.repo.root(secondary)).toBe(secondary);
	});

	it("resolves storeDir to the shared store for a non-default workspace", async () => {
		const dir = await createTempDir();
		const secondary = path.join(dir, "ws2");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await fs.mkdir(path.join(secondary, ".jj", "working_copy"), { recursive: true });
		await fs.writeFile(path.join(secondary, ".jj", "repo"), path.join("..", "..", ".jj", "repo"));

		const resolved = await jj.repo.resolve(secondary);
		expect(resolved?.repoRoot).toBe(secondary);
		expect(resolved?.storeDir).toBe(path.join(dir, ".jj", "repo", "store"));
	});
});

describe("jj workspace detection (sync)", () => {
	let tmpDir: string | undefined;

	afterEach(async () => {
		jj.repo.clearRootCache();
		if (tmpDir) {
			await fs.rm(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	async function createTempDir(): Promise<string> {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-jj-utils-sync-"));
		return tmpDir;
	}

	it("resolves workspace metadata synchronously, including the op-heads watch target", async () => {
		const dir = await createTempDir();
		const nested = path.join(dir, "src");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await fs.mkdir(nested, { recursive: true });

		expect(jj.repo.rootSync(nested)).toBe(dir);
		const resolved = jj.repo.resolveSync(nested);
		expect(resolved?.repoRoot).toBe(dir);
		expect(resolved?.storeDir).toBe(path.join(dir, ".jj", "repo", "store"));
		expect(resolved?.opHeadsDir).toBe(path.join(dir, ".jj", "repo", "op_heads", "heads"));
	});

	it("resolves the shared op-heads dir for a non-default workspace", async () => {
		const dir = await createTempDir();
		const secondary = path.join(dir, "ws2");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await fs.mkdir(path.join(secondary, ".jj", "working_copy"), { recursive: true });
		await fs.writeFile(path.join(secondary, ".jj", "repo"), path.join("..", "..", ".jj", "repo"));

		const resolved = jj.repo.resolveSync(secondary);
		expect(resolved?.repoRoot).toBe(secondary);
		expect(resolved?.opHeadsDir).toBe(path.join(dir, ".jj", "repo", "op_heads", "heads"));
	});

	it("returns null outside jj workspaces", async () => {
		const dir = await createTempDir();
		expect(jj.repo.rootSync(dir)).toBeNull();
		expect(jj.repo.resolveSync(dir)).toBeNull();
	});
});

describe("jj head label parsing", () => {
	it("parses a bookmarked working copy", () => {
		expect(jj.parseHeadLog("pzsxstkt main\n")).toEqual({ changeId: "pzsxstkt", bookmarks: "main" });
	});

	it("falls back to the nearest bookmarked ancestor", () => {
		expect(jj.parseHeadLog("rulxpnlq\nztwysoon main*\n")).toEqual({ changeId: "rulxpnlq", bookmarks: "main*" });
	});

	it("prefers the working copy's own bookmarks over ancestor bookmarks", () => {
		expect(jj.parseHeadLog("rqstuvwx feature\nztwysoon main\n")).toEqual({
			changeId: "rqstuvwx",
			bookmarks: "feature",
		});
	});

	it("returns a bare change id when no bookmark is reachable", () => {
		expect(jj.parseHeadLog("vkovtwrl\n")).toEqual({ changeId: "vkovtwrl", bookmarks: null });
	});

	it("returns null for empty output", () => {
		expect(jj.parseHeadLog("")).toBeNull();
	});

	it("formats labels with and without bookmarks", () => {
		expect(jj.formatHeadLabel({ changeId: "rulxpnlq", bookmarks: "main" })).toBe("rulxpnlq main");
		expect(jj.formatHeadLabel({ changeId: "rulxpnlq", bookmarks: null })).toBe("rulxpnlq");
	});
});

describe.skipIf(!$which("jj"))("jj head label tracker", () => {
	let tmpDir: string | undefined;

	afterEach(async () => {
		jj.headLabel.clearCache();
		jj.repo.clearRootCache();
		if (tmpDir) {
			await fs.rm(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	it("transitions pending → resolved label and notifies subscribers", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-jj-label-"));
		await $`jj git init ${tmpDir}`.quiet();

		let notified = false;
		const unsubscribe = jj.headLabel.subscribe(tmpDir, () => {
			notified = true;
		});
		// Workspace is known synchronously; the label is still resolving.
		expect(jj.headLabel.getSync(tmpDir)).toBeNull();

		const deadline = Date.now() + 10_000;
		let label = jj.headLabel.getSync(tmpDir);
		while (typeof label !== "string" && Date.now() < deadline) {
			await Bun.sleep(25);
			label = jj.headLabel.getSync(tmpDir);
		}
		unsubscribe();

		// A fresh jj repo has no bookmarks: the label is the bare change id of `@`.
		expect(typeof label).toBe("string");
		expect(label as string).toMatch(/^[k-z]{8,}$/);
		expect(notified).toBe(true);
	});
});
