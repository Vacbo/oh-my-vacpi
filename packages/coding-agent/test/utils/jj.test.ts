import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as jj from "@oh-my-pi/pi-coding-agent/utils/jj";
import { $which, removeWithRetries } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

describe("jj workspace detection", () => {
	let tmpDir: string | undefined;

	afterEach(async () => {
		jj.repo.clearRootCache();
		if (tmpDir) {
			await removeWithRetries(tmpDir);
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
		await removeWithRetries(path.join(dir, ".jj"));

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

describe("isPureJjRepo", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		jj.repo.clearRootCache();
		await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	async function createTempDir(prefix: string): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	async function initGit(dir: string): Promise<void> {
		const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
		const exit = async (args: string[]) => {
			const proc = Bun.spawn(["git", "-C", dir, ...args], { env, stdout: "ignore", stderr: "pipe" });
			const code = await proc.exited;
			if (code !== 0) {
				const stderr = await new Response(proc.stderr).text();
				throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
			}
		};
		await exit(["init", "-q", "-b", "main"]);
		await exit(["config", "user.email", "test@example.com"]);
		await exit(["config", "user.name", "Test"]);
	}

	it("flags a pure jj workspace (no colocated git)", async () => {
		const dir = await createTempDir("omp-jj-pure-");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		expect(await jj.isPureJjRepo(dir)).toBe(true);
	});

	it("treats a colocated jj-git workspace as non-pure", async () => {
		const dir = await createTempDir("omp-jj-colocated-");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await initGit(dir);
		expect(await jj.isPureJjRepo(dir)).toBe(false);
	});

	it("returns false for a plain git checkout (no jj metadata)", async () => {
		const dir = await createTempDir("omp-jj-plaingit-");
		await initGit(dir);
		expect(await jj.isPureJjRepo(dir)).toBe(false);
	});

	it("returns false when neither jj nor git metadata is present", async () => {
		const dir = await createTempDir("omp-jj-empty-");
		expect(await jj.isPureJjRepo(dir)).toBe(false);
	});

	it("flags a jj workspace nested inside an unrelated git checkout as pure", async () => {
		const outer = await createTempDir("omp-jj-nested-outer-");
		await initGit(outer);
		const inner = path.join(outer, "nested");
		await fs.mkdir(path.join(inner, ".jj", "repo", "store"), { recursive: true });
		// The inner directory is its own jj workspace; the surrounding git
		// checkout would mutate state outside jj's model.
		expect(await jj.isPureJjRepo(inner)).toBe(true);
	});

	it("treats a nested git checkout under an outer jj workspace as non-pure", async () => {
		// `git.repo.root(inner)` returns the inner .git, so Git automation
		// targets the nested checkout safely and never touches the surrounding
		// jj tree — the inner git wins.
		const outer = await createTempDir("omp-jj-nested-jj-outer-");
		await fs.mkdir(path.join(outer, ".jj", "repo", "store"), { recursive: true });
		const inner = path.join(outer, "vendor");
		await fs.mkdir(inner, { recursive: true });
		await initGit(inner);
		expect(await jj.isPureJjRepo(inner)).toBe(false);
	});
});
