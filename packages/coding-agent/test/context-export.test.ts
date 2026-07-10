import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	CONTEXT_EXPORT_TASK_TOO_LONG_MESSAGE,
	ContextExportError,
	type ContextExportErrorCode,
	prepareContextExport,
	publishContextExport,
} from "@oh-my-pi/pi-coding-agent/context-export";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	CONTEXT_EXPORT_WORKFLOW_NOT_FOUND_MESSAGE,
	ContextExportTool,
	isContextExportController,
} from "@oh-my-pi/pi-coding-agent/tools/context-export";
import * as natives from "@oh-my-pi/pi-natives";

const tempDirs: string[] = [];

async function makeRepo(files: Record<string, string | Uint8Array>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-export-core-"));
	tempDirs.push(dir);
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(dir, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content);
	}
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function expectCode(promise: Promise<unknown>, code: ContextExportErrorCode): Promise<ContextExportError> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof ContextExportError) {
			expect(err.code).toBe(code);
			return err;
		}
		throw err;
	}
	throw new Error(`Expected ContextExportError(${code}); nothing was thrown.`);
}

describe("prepareContextExport selection", () => {
	it("base none: directory include recurses, a later exclude overrides, and native order is kept", async () => {
		const root = await makeRepo({
			"a.txt": "root file\n",
			"src/a.ts": "const a = 1;\n",
			"src/b.ts": "const b = 1;\n",
			"zz.txt": "tail\n",
		});
		const prepared = await prepareContextExport({
			rootPath: root,
			task: "ordering",
			selection: {
				base: "none",
				operations: [
					{ action: "include", path: "src" },
					{ action: "include", path: "a.txt" },
					{ action: "include", path: "zz.txt" },
					{ action: "exclude", path: "src/b.ts" },
				],
			},
		});
		expect(prepared.stats.selectedFileCount).toBe(3);
		expect(prepared.markdown).not.toContain('### File "src/b.ts"');
		const order = ['### File "a.txt"', '### File "src/a.ts"', '### File "zz.txt"'].map(marker =>
			prepared.markdown.indexOf(marker),
		);
		expect(order.every(index => index >= 0)).toBe(true);
		expect([...order].sort((x, y) => x - y)).toEqual(order);
	});

	it("base all: gitignored files stay out, hidden files stay in, symlinks and prompt-exports are excluded, and a directory exclude can be re-included", async () => {
		const root = await makeRepo({
			".gitignore": "ignored.txt\n",
			".hidden.md": "hidden\n",
			"ignored.txt": "invisible\n",
			"keep.ts": "kept\n",
			"prompt-exports/old.md": "old export\n",
			"test/a.test.ts": "assert\n",
			"test/b.test.ts": "assert b\n",
		});
		await fs.symlink(path.join(root, "keep.ts"), path.join(root, "link.ts"));
		const prepared = await prepareContextExport({
			rootPath: root,
			task: "cross-cutting",
			selection: {
				base: "all",
				operations: [
					{ action: "exclude", path: "test" },
					{ action: "include", path: "test/a.test.ts" },
				],
			},
		});
		expect(prepared.markdown).toContain('### File ".hidden.md"');
		expect(prepared.markdown).toContain('### File "test/a.test.ts"');
		expect(prepared.markdown).not.toContain('"test/b.test.ts"');
		// `.gitignore` itself is selected and its content names "ignored.txt";
		// only the ignored FILE (section + content) must be absent.
		expect(prepared.markdown).not.toContain('### File "ignored.txt"');
		expect(prepared.markdown).not.toContain("invisible");
		expect(prepared.markdown).not.toContain("link.ts");
		expect(prepared.markdown).not.toContain("old export");
	});

	it("treats glob-looking filenames literally", async () => {
		const root = await makeRepo({
			"src/[id].ts": "bracket file\n",
			"src/star*.ts": "star file\n",
		});
		const prepared = await prepareContextExport({
			rootPath: root,
			task: "brackets",
			selection: { base: "none", operations: [{ action: "include", path: "src/[id].ts" }] },
		});
		expect(prepared.stats.selectedFileCount).toBe(1);
		expect(prepared.markdown).toContain(JSON.stringify("src/[id].ts"));
		expect(prepared.markdown).not.toContain("star file");
	});

	it("unions overlapping/adjacent ranged includes and complements a ranged exclude of a full file", async () => {
		const root = await makeRepo({
			"ten.txt": `${Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n")}\n`,
		});
		const union = await prepareContextExport({
			rootPath: root,
			task: "union",
			selection: {
				base: "none",
				operations: [
					{ action: "include", path: "ten.txt", ranges: [{ startLine: 2, endLine: 4 }] },
					{
						action: "include",
						path: "ten.txt",
						ranges: [
							{ startLine: 4, endLine: 5 },
							{ startLine: 6, endLine: 6 },
						],
					},
				],
			},
		});
		// 2-4 ∪ 4-5 ∪ 6-6 merges into one 2-6 slice.
		expect(union.stats.sliceRangeCount).toBe(1);
		expect(union.markdown).toContain("Lines 2-6");

		const complement = await prepareContextExport({
			rootPath: root,
			task: "complement",
			selection: {
				base: "none",
				operations: [
					{ action: "include", path: "ten.txt" },
					{ action: "exclude", path: "ten.txt", ranges: [{ startLine: 4, endLine: 6 }] },
				],
			},
		});
		expect(complement.stats.sliceRangeCount).toBe(2);
		expect(complement.markdown).toContain("Lines 1-3");
		expect(complement.markdown).toContain("Lines 7-10");
		expect(complement.markdown).not.toContain("L5");
	});

	it("rejects escaping/absolute/malformed paths and unknown paths distinctly", async () => {
		const root = await makeRepo({ "ok.txt": "fine\n" });
		for (const bad of ["../up", "/abs", "a\\b", "a//b", ".", "a/./b", "a/../b"]) {
			await expectCode(
				prepareContextExport({
					rootPath: root,
					task: "paths",
					selection: { base: "none", operations: [{ action: "include", path: bad }] },
				}),
				"invalid-path",
			);
		}
		await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "paths",
				selection: { base: "none", operations: [{ action: "include", path: "missing.txt" }] },
			}),
			"path-not-found",
		);
	});

	it("rejects empty ranges arrays and out-of-bounds ranges without clamping", async () => {
		const root = await makeRepo({ "two.txt": "one\ntwo\n", "empty.txt": "" });
		const cases: { path: string; ranges: { startLine: number; endLine: number }[] }[] = [
			{ path: "two.txt", ranges: [] },
			{ path: "two.txt", ranges: [{ startLine: 0, endLine: 1 }] },
			{ path: "two.txt", ranges: [{ startLine: 2, endLine: 1 }] },
			{ path: "two.txt", ranges: [{ startLine: 1, endLine: 3 }] },
			{ path: "empty.txt", ranges: [{ startLine: 1, endLine: 1 }] },
		];
		for (const { path: p, ranges } of cases) {
			await expectCode(
				prepareContextExport({
					rootPath: root,
					task: "ranges",
					selection: { base: "none", operations: [{ action: "include", path: p, ranges }] },
				}),
				"invalid-range",
			);
		}
	});

	it("rejects an empty final selection", async () => {
		const root = await makeRepo({ "a.txt": "content\n" });
		await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "empty",
				selection: {
					base: "none",
					operations: [
						{ action: "include", path: "a.txt" },
						{ action: "exclude", path: "a.txt" },
					],
				},
			}),
			"empty-selection",
		);
	});
});

describe("prepareContextExport inventory safety", () => {
	it("fails closed on a truncated inventory", async () => {
		const root = await makeRepo({ "a.txt": "content\n" });
		vi.spyOn(natives, "listWorkspace").mockResolvedValue({
			entries: [{ path: "a.txt", fileType: natives.FileType.File, size: 8 }],
			agentsMdFiles: [],
			truncated: true,
		});
		await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "truncated",
				selection: { base: "all", operations: [] },
			}),
			"inventory-truncated",
		);
	});

	it("fails closed on unaddressable inventory paths", async () => {
		const root = await makeRepo({ "a.txt": "content\n" });
		vi.spyOn(natives, "listWorkspace").mockResolvedValue({
			entries: [{ path: "../evil", fileType: natives.FileType.File, size: 4 }],
			agentsMdFiles: [],
			truncated: false,
		});
		await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "unsafe",
				selection: { base: "all", operations: [] },
			}),
			"inventory-unsafe",
		);
	});

	it("fails when a selected file changed since inventory", async () => {
		const root = await makeRepo({ "a.txt": "content\n" });
		const realListWorkspace = natives.listWorkspace;
		vi.spyOn(natives, "listWorkspace").mockImplementation(async options => {
			const result = await realListWorkspace(options);
			return {
				...result,
				entries: result.entries.map(entry =>
					entry.path === "a.txt" ? { ...entry, size: (entry.size ?? 0) + 1 } : entry,
				),
			};
		});
		await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "changed",
				selection: { base: "none", operations: [{ action: "include", path: "a.txt" }] },
			}),
			"file-changed",
		);
	});
});

describe("prepareContextExport safety policy", () => {
	it("skips denied/binary files selected incidentally but fails an explicit include", async () => {
		const root = await makeRepo({
			".env": "SECRET=1\n",
			"bin.dat": new Uint8Array([0, 1, 2, 255]),
			"ok.txt": "fine\n",
		});
		const incidental = await prepareContextExport({
			rootPath: root,
			task: "skips",
			selection: { base: "all", operations: [] },
		});
		expect(incidental.skips).toEqual(
			expect.arrayContaining([
				{ path: ".env", reason: "sensitive path" },
				{ path: "bin.dat", reason: "binary file" },
			]),
		);
		expect(incidental.markdown).not.toContain("SECRET=1");

		await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "denied",
				selection: { base: "none", operations: [{ action: "include", path: ".env" }] },
			}),
			"denied-path",
		);
		await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "binary",
				selection: { base: "none", operations: [{ action: "include", path: "bin.dat" }] },
			}),
			"binary-file",
		);
	});

	it("denies an explicit sensitive path before revealing whether it exists", async () => {
		const root = await makeRepo({ "ok.txt": "fine\n" });
		// id_rsa does not exist; the denylist must still answer, not "not found".
		await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "probe",
				selection: { base: "none", operations: [{ action: "include", path: "id_rsa" }] },
			}),
			"denied-path",
		);
	});

	it("fails on configured secrets without leaking the value, including operation-path-only matches", async () => {
		const secret = "sk-live-abcdefgh12345678";
		const root = await makeRepo({
			"leaky.txt": `token=${secret}\n`,
			"ok.txt": "fine\n",
			[`${secret}.txt`]: "named after a secret\n",
		});
		const detector = () => new SecretObfuscator([{ type: "plain", content: secret, mode: "obfuscate" }]);

		const contentHit = await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "secret content",
				selection: { base: "none", operations: [{ action: "include", path: "leaky.txt" }] },
				secretDetector: detector(),
			}),
			"secret-detected",
		);
		expect(contentHit.message).toContain("content of leaky.txt");
		expect(contentHit.message).not.toContain(secret);

		// The secret appears ONLY as an operation path (the file itself is excluded).
		const opHit = await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "secret op path",
				selection: {
					base: "all",
					operations: [
						{ action: "exclude", path: `${secret}.txt` },
						{ action: "exclude", path: "leaky.txt" },
					],
				},
				secretDetector: detector(),
			}),
			"secret-detected",
		);
		expect(opHit.message).toContain("operation 1 path");
		expect(opHit.message).not.toContain(secret);
	});
});

describe("prepareContextExport limits", () => {
	it("enforces operation, supplied-range, per-file-range, byte, and token limits", async () => {
		const root = await makeRepo({
			"big.txt": "0123456789\n".repeat(20),
			"other.txt": "abc\n",
		});
		await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "ops",
				selection: {
					base: "none",
					operations: [
						{ action: "include", path: "big.txt" },
						{ action: "include", path: "other.txt" },
					],
				},
				limits: { maxSelectionOperations: 1 },
			}),
			"limit-exceeded",
		);
		await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "ranges",
				selection: {
					base: "none",
					operations: [
						{
							action: "include",
							path: "big.txt",
							ranges: [
								{ startLine: 1, endLine: 1 },
								{ startLine: 3, endLine: 3 },
							],
						},
					],
				},
				limits: { maxSelectionRanges: 1 },
			}),
			"limit-exceeded",
		);
		await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "rangesPerFile",
				selection: {
					base: "none",
					operations: [
						{
							action: "include",
							path: "big.txt",
							ranges: [
								{ startLine: 1, endLine: 1 },
								{ startLine: 3, endLine: 3 },
							],
						},
					],
				},
				limits: { maxRangesPerFile: 1 },
			}),
			"limit-exceeded",
		);
		await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "fileBytes",
				selection: { base: "none", operations: [{ action: "include", path: "big.txt" }] },
				limits: { maxSourceFileBytes: 8 },
			}),
			"limit-exceeded",
		);
		await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "totalBytes",
				selection: {
					base: "none",
					operations: [
						{ action: "include", path: "big.txt" },
						{ action: "include", path: "other.txt" },
					],
				},
				limits: { maxTotalReadBytes: 8 },
			}),
			"limit-exceeded",
		);
		const budget = await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "tokens",
				selection: { base: "none", operations: [{ action: "include", path: "big.txt" }] },
				limits: { maxTokens: 3 },
			}),
			"token-budget",
		);
		expect(budget.message).toContain("big.txt");
		expect(budget.message).toContain("limit is 3");
	});

	it("charges the read budget for range-validation reads even when a later rule excludes the file", async () => {
		const root = await makeRepo({
			"probe.txt": "0123456789\n".repeat(4),
			"tiny.txt": "ab\n",
		});
		await expectCode(
			prepareContextExport({
				rootPath: root,
				task: "budgeted probe",
				selection: {
					base: "none",
					operations: [
						{ action: "include", path: "probe.txt", ranges: [{ startLine: 1, endLine: 1 }] },
						{ action: "exclude", path: "probe.txt" },
						{ action: "include", path: "tiny.txt" },
					],
				},
				// probe.txt (44 bytes) alone exceeds the budget even though it is
				// excluded from the final selection.
				limits: { maxTotalReadBytes: 20 },
			}),
			"limit-exceeded",
		);
	});
});

describe("prepareContextExport rendering fidelity", () => {
	it("preserves BOM, CRLF, trailing whitespace, and terminal-newline metadata", async () => {
		const root = await makeRepo({
			"bom.txt": "\uFEFFbom line\n",
			"crlf.txt": "one\r\ntwo  \r\n",
			"nonl.txt": "no terminal newline",
		});
		const prepared = await prepareContextExport({
			rootPath: root,
			task: "fidelity",
			selection: {
				base: "none",
				operations: [
					{ action: "include", path: "bom.txt" },
					{ action: "include", path: "crlf.txt" },
					{ action: "include", path: "nonl.txt" },
				],
			},
		});
		expect(prepared.markdown).toContain("\uFEFFbom line\n");
		expect(prepared.markdown).toContain("one\r\ntwo  \r\n");
		expect(prepared.markdown).toContain("no terminal newline\n```");
		expect(prepared.markdown).toContain("Terminal newline in source: false");
	});

	it("chooses collision-safe fences: shorter delimiter wins, backticks on a tie", async () => {
		const root = await makeRepo({
			"backticks.md": "has ```` run\n",
			"tildes.md": "has ~~~~ run\n",
			"both.md": "has ``` and ~~~ runs\n",
		});
		const prepared = await prepareContextExport({
			rootPath: root,
			task: "fences",
			selection: {
				base: "none",
				operations: [
					{ action: "include", path: "backticks.md" },
					{ action: "include", path: "tildes.md" },
					{ action: "include", path: "both.md" },
				],
			},
		});
		expect(prepared.markdown).toContain("~~~markdown\nhas ```` run\n~~~");
		expect(prepared.markdown).toContain("```markdown\nhas ~~~~ run\n```");
		// Tie at length 4: backticks win.
		expect(prepared.markdown).toContain("````markdown\nhas ``` and ~~~ runs\n````");
	});
});

describe("publishContextExport", () => {
	it("publishes the exact cached bytes even after source mutation and cleans its temp", async () => {
		const root = await makeRepo({ "a.txt": "before mutation\n" });
		const prepared = await prepareContextExport({
			rootPath: root,
			task: "snapshot",
			selection: { base: "none", operations: [{ action: "include", path: "a.txt" }] },
		});
		await fs.writeFile(path.join(root, "a.txt"), "MUTATED\n");
		const result = await publishContextExport(prepared);
		expect(result.destination).toBe(prepared.destination);
		const onDisk = await fs.readFile(path.join(root, result.destination), "utf8");
		expect(onDisk).toBe(prepared.markdown);
		expect(onDisk).toContain("before mutation\n");
		const dirEntries = await fs.readdir(path.join(root, "prompt-exports"));
		expect(dirEntries.some(name => name.endsWith(".tmp"))).toBe(false);
		if (process.platform !== "win32") {
			const dirStat = await fs.stat(path.join(root, "prompt-exports"));
			expect(dirStat.mode & 0o777).toBe(0o700);
			const fileStat = await fs.stat(path.join(root, result.destination));
			expect(fileStat.mode & 0o777).toBe(0o600);
		}
	});

	it("never overwrites an existing destination and preserves it on failure", async () => {
		const root = await makeRepo({ "a.txt": "content\n" });
		const prepared = await prepareContextExport({
			rootPath: root,
			task: "collision",
			selection: { base: "none", operations: [{ action: "include", path: "a.txt" }] },
		});
		await fs.mkdir(path.join(root, "prompt-exports"), { recursive: true });
		await fs.writeFile(path.join(root, prepared.destination), "existing\n");
		await expectCode(publishContextExport(prepared), "publish-failed");
		expect(await fs.readFile(path.join(root, prepared.destination), "utf8")).toBe("existing\n");
		const dirEntries = await fs.readdir(path.join(root, "prompt-exports"));
		expect(dirEntries.some(name => name.endsWith(".tmp"))).toBe(false);
	});

	it("refuses a symlinked prompt-exports directory", async () => {
		const root = await makeRepo({ "a.txt": "content\n", "elsewhere/keep": "x\n" });
		await fs.symlink(path.join(root, "elsewhere"), path.join(root, "prompt-exports"));
		const prepared = await prepareContextExport({
			rootPath: root,
			task: "symlink",
			selection: { base: "none", operations: [{ action: "include", path: "a.txt" }] },
		});
		await expectCode(publishContextExport(prepared), "publish-failed");
		expect(await fs.readFile(path.join(root, "elsewhere/keep"), "utf8")).toBe("x\n");
	});
});

describe("ContextExportTool workflow", () => {
	function makeToolSession(cwd: string, agentDir: string): ToolSession {
		const settings = Settings.isolated();
		vi.spyOn(settings, "getAgentDir").mockReturnValue(agentDir);
		return {
			cwd,
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
	}

	async function makeTool(
		files: Record<string, string | Uint8Array>,
	): Promise<{ tool: ContextExportTool; root: string }> {
		const root = await makeRepo(files);
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-export-agent-"));
		tempDirs.push(agentDir);
		const tool = ContextExportTool.createIf(makeToolSession(root, agentDir));
		if (!tool) throw new Error("expected top-level tool");
		return { tool, root };
	}

	const previewArgs = (workflowId: string) => ({
		action: "preview" as const,
		workflow_id: workflowId,
		selection: { base: "none" as const, operations: [{ action: "include" as const, path: "a.txt" }] },
	});

	it("is top-level only and exposes the controller surface", async () => {
		const { tool } = await makeTool({ "a.txt": "x\n" });
		expect(isContextExportController(tool)).toBe(true);
		const settings = Settings.isolated();
		expect(
			ContextExportTool.createIf({
				cwd: "/tmp",
				hasUI: false,
				settings,
				taskDepth: 1,
				getSessionFile: () => null,
				getSessionSpawns: () => null,
			}),
		).toBeNull();
	});

	it("classifies preview as read and write as write for approval", async () => {
		const { tool } = await makeTool({ "a.txt": "x\n" });
		expect(tool.approval({ action: "preview" })).toBe("read");
		expect(tool.approval({ action: "write" })).toBe("write");
	});

	it("rejects empty and oversized tasks with the exact contract messages", async () => {
		const { tool } = await makeTool({ "a.txt": "x\n" });
		expect(() => tool.beginContextExport("   ")).toThrow("Context export task must not be empty.");
		expect(() => tool.beginContextExport("x".repeat(20_001))).toThrow(CONTEXT_EXPORT_TASK_TOO_LONG_MESSAGE);
	});

	it("requires a command-issued workflow and rejects wrong IDs without dropping valid state", async () => {
		const { tool } = await makeTool({ "a.txt": "workflow content\n" });
		await expect(tool.execute("t0", previewArgs("nope"))).rejects.toThrow(CONTEXT_EXPORT_WORKFLOW_NOT_FOUND_MESSAGE);
		const workflowId = tool.beginContextExport("  exact task text  ");
		await expect(tool.execute("t1", previewArgs("wrong-id"))).rejects.toThrow("Unknown context export workflow ID");
		// Valid state survived the wrong-ID call.
		const preview = await tool.execute("t2", previewArgs(workflowId));
		const details = preview.details;
		if (!details?.previewId) throw new Error("expected preview details");
		expect(details.destination.startsWith("prompt-exports/")).toBe(true);
		// The slug derives from the exact trimmed command-bound task.
		expect(details.destination).toContain("exact-task-text");
	});

	it("enforces the two-call protocol: cross-action fields, write-without-preview, receipt consumption, and exact publication", async () => {
		const { tool, root } = await makeTool({ "a.txt": "tool content\n" });
		const workflowId = tool.beginContextExport("publish me");
		await expect(
			tool.execute("t0", { action: "write", workflow_id: workflowId, preview_id: "missing" }),
		).rejects.toThrow("No context export preview is pending");
		await expect(tool.execute("t1", { ...previewArgs(workflowId), preview_id: "extra" })).rejects.toThrow(
			"preview does not accept preview_id",
		);

		const preview = await tool.execute("t2", previewArgs(workflowId));
		const previewId = preview.details?.previewId;
		if (!previewId) throw new Error("expected preview receipt");
		await expect(
			tool.execute("t3", {
				action: "write",
				workflow_id: workflowId,
				preview_id: previewId,
				selection: { base: "none", operations: [] },
			}),
		).rejects.toThrow("write does not accept selection");
		await expect(
			tool.execute("t4", { action: "write", workflow_id: workflowId, preview_id: "bogus" }),
		).rejects.toThrow("Unknown context export preview ID");

		// Mutate the source after preview; write must publish the cached bytes.
		await fs.writeFile(path.join(root, "a.txt"), "MUTATED\n");
		const write = await tool.execute("t5", { action: "write", workflow_id: workflowId, preview_id: previewId });
		const destination = write.details?.destination;
		if (!destination) throw new Error("expected write destination");
		const onDisk = await fs.readFile(path.join(root, destination), "utf8");
		expect(onDisk).toContain("tool content\n");
		expect(onDisk).not.toContain("MUTATED");
		expect(onDisk).toContain(JSON.stringify("publish me"));

		// The workflow ended with the successful write.
		await expect(tool.execute("t6", previewArgs(workflowId))).rejects.toThrow(
			CONTEXT_EXPORT_WORKFLOW_NOT_FOUND_MESSAGE,
		);
	});

	it("invalidates a pending receipt on re-preview and on a new command binding", async () => {
		const { tool } = await makeTool({ "a.txt": "receipts\n" });
		const workflowId = tool.beginContextExport("first");
		const first = await tool.execute("t0", previewArgs(workflowId));
		const firstReceipt = first.details?.previewId;
		if (!firstReceipt) throw new Error("expected first receipt");
		const second = await tool.execute("t1", previewArgs(workflowId));
		const secondReceipt = second.details?.previewId;
		if (!secondReceipt) throw new Error("expected second receipt");
		expect(secondReceipt).not.toBe(firstReceipt);
		await expect(
			tool.execute("t2", { action: "write", workflow_id: workflowId, preview_id: firstReceipt }),
		).rejects.toThrow("Unknown context export preview ID");

		// A fresh command binding invalidates everything from the prior workflow.
		const newWorkflowId = tool.beginContextExport("second");
		await expect(
			tool.execute("t3", { action: "write", workflow_id: newWorkflowId, preview_id: secondReceipt }),
		).rejects.toThrow("No context export preview is pending");
		await expect(tool.execute("t4", previewArgs(workflowId))).rejects.toThrow("Unknown context export workflow ID");
	});

	it("detects project-configured secrets through the real loadSecrets path", async () => {
		const secret = "cfg-secret-0123456789abcdef";
		const { tool } = await makeTool({
			".omp/secrets.yml": `- type: plain\n  content: "${secret}"\n`,
			"a.txt": `value=${secret}\n`,
		});
		const workflowId = tool.beginContextExport("secret scan");
		await expect(tool.execute("t0", previewArgs(workflowId))).rejects.toThrow("content of a.txt");
	});
});
