/**
 * Deterministic repository-context export core for `/context-export`.
 *
 * Builds a task-focused Markdown bundle from an ordered include/exclude
 * selection program over the gitignore-respecting workspace inventory, then
 * publishes it atomically under `prompt-exports/`. The core performs no model
 * or network calls; the calling tool owns workflow/receipt state and secret
 * detector construction.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { countTokens, FileType, listWorkspace } from "@oh-my-pi/pi-natives";
import { isEnoent, isProbablyBinaryHeader, prompt } from "@oh-my-pi/pi-utils";
import outputTemplate from "./prompts/context-export/output.md" with { type: "text" };
import type { SecretObfuscator } from "./secrets";
import { mapWithConcurrencyLimit } from "./task/parallel";
import { getLanguageFromPath } from "./utils/lang-from-path";

// ═══════════════════════════════════════════════════════════════════════════
// Public contract
// ═══════════════════════════════════════════════════════════════════════════

export interface ContextExportLineRange {
	startLine: number;
	endLine: number;
}

export interface ContextExportSelectionOperation {
	action: "include" | "exclude";
	path: string;
	ranges?: readonly ContextExportLineRange[];
}

export interface ContextExportSelection {
	base: "all" | "none";
	operations: readonly ContextExportSelectionOperation[];
}

export interface ContextExportLimits {
	/** Cap on the final rendered bundle in o200k_base tokens. */
	maxTokens: number;
	/** Cap on the number of selected files. */
	maxSelectedFiles: number;
	/** Cap on a single source file's byte size. */
	maxSourceFileBytes: number;
	/** Cap on total bytes read, including range-validation reads later excluded. */
	maxTotalReadBytes: number;
	/** Cap on the number of selection operations. */
	maxSelectionOperations: number;
	/** Cap on the total number of supplied ranges across all operations. */
	maxSelectionRanges: number;
	/** Cap on normalized (merged) ranges per file. */
	maxRangesPerFile: number;
}

/**
 * Production limits. `maxTokens` reserves ~100k of a one-million-token target
 * context for the consumer's instructions, conversation, and answer.
 */
export const CONTEXT_EXPORT_LIMITS: ContextExportLimits = {
	maxTokens: 900_000,
	maxSelectedFiles: 10_000,
	maxSourceFileBytes: 8 * 1024 * 1024,
	maxTotalReadBytes: 32 * 1024 * 1024,
	maxSelectionOperations: 10_000,
	maxSelectionRanges: 4_096,
	maxRangesPerFile: 256,
};

export const CONTEXT_EXPORT_TASK_MAX_LENGTH = 20_000;
export const CONTEXT_EXPORT_TASK_TOO_LONG_MESSAGE = "Context export task must not exceed 20,000 characters.";

/** Repo-relative output directory. Excluded from the selectable inventory. */
export const CONTEXT_EXPORT_DIR = "prompt-exports";

/** Entry cap enforced by the native workspace walker (surfaces as `truncated`). */
export const CONTEXT_EXPORT_INVENTORY_ENTRY_CAP = 100_000;

export type ContextExportErrorCode =
	| "invalid-task"
	| "invalid-selection"
	| "invalid-path"
	| "path-not-found"
	| "invalid-range"
	| "inventory-truncated"
	| "inventory-unsafe"
	| "denied-path"
	| "binary-file"
	| "file-changed"
	| "unreadable-file"
	| "limit-exceeded"
	| "token-budget"
	| "secret-detected"
	| "empty-selection"
	| "publish-failed";

export class ContextExportError extends Error {
	constructor(
		readonly code: ContextExportErrorCode,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "ContextExportError";
	}
}

export interface PrepareContextExportOptions {
	rootPath: string;
	/** Exact trimmed task text as bound by the slash command. */
	task: string;
	selection: ContextExportSelection;
	/** Used only as a detector: transformed output is compared, never emitted. */
	secretDetector?: SecretObfuscator;
	signal?: AbortSignal;
	limits?: Partial<ContextExportLimits>;
	/** Timestamp for the destination name; defaults to now. Injectable for tests. */
	now?: Date;
}

export interface ContextExportSkip {
	path: string;
	reason: "sensitive path" | "binary file";
}

export interface ContextExportPayloadInfo {
	path: string;
	bytes: number;
}

export interface ContextExportStats {
	inventoryEntryCount: number;
	inventoryFileCount: number;
	inventoryDirCount: number;
	selectedFileCount: number;
	fullFileCount: number;
	slicedFileCount: number;
	sliceRangeCount: number;
	sourceBytes: number;
	renderedBytes: number;
	tokens: number;
	maxTokens: number;
	tokenHeadroom: number;
}

export interface PreparedContextExport {
	rootPath: string;
	/** Repo-relative POSIX destination under {@link CONTEXT_EXPORT_DIR}. */
	destination: string;
	/** Final bundle bytes; `publishContextExport` writes exactly this string. */
	markdown: string;
	stats: ContextExportStats;
	skips: ContextExportSkip[];
	/** Top 20 selected payloads by UTF-8 bytes, descending. */
	largestPayloads: ContextExportPayloadInfo[];
	/** "clean" when a detector ran and found nothing; "skipped" when no detector was supplied. */
	secretScan: "clean" | "skipped";
}

export interface ContextExportWriteResult {
	destination: string;
	bytesWritten: number;
	tokens: number;
	sourceBytes: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Path policy
// ═══════════════════════════════════════════════════════════════════════════

/* eslint-disable no-control-regex -- control chars are exactly what we reject */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DRIVE_PREFIX = /^[a-zA-Z]:/;

/** Validate a repository-relative POSIX path (native output or operation input). */
function isSafeRelativePosixPath(p: string): boolean {
	if (!p || p === ".") return false;
	if (p.includes("\\") || CONTROL_CHARS.test(p)) return false;
	if (p.startsWith("/") || DRIVE_PREFIX.test(p)) return false;
	const components = p.split("/");
	return components.every(c => c.length > 0 && c !== "." && c !== "..");
}

const DENIED_BASENAMES: Record<string, true> = {
	".npmrc": true,
	".pypirc": true,
	".netrc": true,
	id_rsa: true,
	id_dsa: true,
	id_ecdsa: true,
	id_ed25519: true,
	"credentials.json": true,
};
const DENIED_EXTENSIONS: Record<string, true> = {
	".pem": true,
	".key": true,
	".p12": true,
	".pfx": true,
	".jks": true,
	".keystore": true,
};
const ALLOWED_ENV_BASENAMES: Record<string, true> = {
	".env.example": true,
	".env.sample": true,
	".env.template": true,
};

/**
 * Case-insensitive, non-overridable sensitive-path denylist. Checked before
 * inventory existence so an explicit include of a denied path never leaks
 * whether the file exists.
 */
export function isDeniedContextExportPath(relPath: string): boolean {
	const lower = relPath.toLowerCase();
	if (lower === ".omp/secrets.yml") return true;
	const base = lower.slice(lower.lastIndexOf("/") + 1);
	if (base === ".env" || (base.startsWith(".env.") && ALLOWED_ENV_BASENAMES[base] !== true)) return true;
	if (DENIED_BASENAMES[base] === true) return true;
	const dot = base.lastIndexOf(".");
	if (dot > 0 && DENIED_EXTENSIONS[base.slice(dot)] === true) return true;
	if (base.includes("service-account") && base.endsWith(".json")) return true;
	return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Interval algebra (1-indexed inclusive line ranges)
// ═══════════════════════════════════════════════════════════════════════════

interface Interval {
	start: number;
	end: number;
}

/** Sort and merge overlapping/adjacent intervals. */
function mergeIntervals(list: readonly Interval[]): Interval[] {
	const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end);
	const out: Interval[] = [];
	for (const iv of sorted) {
		const last = out[out.length - 1];
		if (last && iv.start <= last.end + 1) {
			last.end = Math.max(last.end, iv.end);
		} else {
			out.push({ start: iv.start, end: iv.end });
		}
	}
	return out;
}

/** Subtract merged `remove` from merged `base`. */
function subtractIntervals(base: readonly Interval[], remove: readonly Interval[]): Interval[] {
	const out: Interval[] = [];
	for (const iv of base) {
		let cursor = iv.start;
		for (const rm of remove) {
			if (rm.end < cursor || rm.start > iv.end) continue;
			if (rm.start > cursor) out.push({ start: cursor, end: rm.start - 1 });
			cursor = Math.max(cursor, rm.end + 1);
			if (cursor > iv.end) break;
		}
		if (cursor <= iv.end) out.push({ start: cursor, end: iv.end });
	}
	return out;
}

/** Extract an errno-style `code` without trusting the error's shape. */
function errnoCode(err: unknown): string | undefined {
	if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
		return err.code;
	}
	return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Line accounting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Split decoded content into lines that KEEP their original terminators.
 * An empty file has zero lines; a terminal newline does not invent a final
 * blank line ("a\nb\n" and "a\nb" are both 2 lines).
 */
function splitLinesKeepTerminators(content: string): string[] {
	if (content.length === 0) return [];
	return content.split(/(?<=\n)/);
}

// ═══════════════════════════════════════════════════════════════════════════
// Safe source reads
// ═══════════════════════════════════════════════════════════════════════════

interface SourceRead {
	binary: boolean;
	/** Decoded UTF-8 content (BOM preserved). Empty string when binary. */
	content: string;
	bytes: number;
	lines: string[];
}

/**
 * Open a source file without following symlinks, verify it still matches the
 * inventory snapshot, read it from the same handle, and re-stat so a
 * concurrent replacement fails instead of producing an ambiguous snapshot.
 */
async function readSourceFile(
	absPath: string,
	relPath: string,
	inventory: { size: number; mtime?: number },
): Promise<SourceRead> {
	const oNoFollow = fs.constants.O_NOFOLLOW ?? 0;
	let handle: fs.FileHandle | undefined;
	try {
		if (oNoFollow) {
			handle = await fs.open(absPath, fs.constants.O_RDONLY | oNoFollow);
		} else {
			const lst = await fs.lstat(absPath);
			if (!lst.isFile()) {
				throw new ContextExportError("unreadable-file", `Not a regular file: ${relPath}`);
			}
			handle = await fs.open(absPath, fs.constants.O_RDONLY);
			const opened = await handle.stat();
			if (opened.dev !== lst.dev || opened.ino !== lst.ino) {
				throw new ContextExportError("file-changed", `File changed while opening: ${relPath}`);
			}
		}
		const first = await handle.stat();
		if (!first.isFile()) {
			throw new ContextExportError("unreadable-file", `Not a regular file: ${relPath}`);
		}
		if (first.size !== inventory.size) {
			throw new ContextExportError("file-changed", `File changed since inventory: ${relPath}`);
		}
		if (inventory.mtime !== undefined && Math.abs(Math.trunc(first.mtimeMs) - inventory.mtime) > 2) {
			throw new ContextExportError("file-changed", `File changed since inventory: ${relPath}`);
		}
		const buffer = await handle.readFile();
		const second = await handle.stat();
		if (second.size !== first.size || second.mtimeMs !== first.mtimeMs) {
			throw new ContextExportError("file-changed", `File changed during read: ${relPath}`);
		}
		if (isProbablyBinaryHeader(buffer.subarray(0, 8192))) {
			return { binary: true, content: "", bytes: buffer.byteLength, lines: [] };
		}
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
		} catch {
			throw new ContextExportError("unreadable-file", `Not valid UTF-8: ${relPath}`);
		}
		return { binary: false, content, bytes: buffer.byteLength, lines: splitLinesKeepTerminators(content) };
	} catch (err) {
		if (err instanceof ContextExportError) throw err;
		// Never forward raw fs error messages: they embed the absolute path.
		const code = errnoCode(err);
		throw new ContextExportError("unreadable-file", `Cannot read ${relPath}${code ? ` (${code})` : ""}.`);
	} finally {
		await handle?.close().catch(() => {});
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Fences and destination
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pick a fence that cannot collide with the payload: one more than the payload's
 * longest backtick or tilde run (minimum three), shorter delimiter wins,
 * backticks on a tie.
 */
export function chooseFence(payload: string): string {
	let longestBacktick = 0;
	let longestTilde = 0;
	let run = 0;
	let runChar = "";
	for (const ch of payload) {
		if (ch === runChar && (ch === "`" || ch === "~")) {
			run++;
		} else {
			runChar = ch;
			run = ch === "`" || ch === "~" ? 1 : 0;
		}
		if (runChar === "`") longestBacktick = Math.max(longestBacktick, run);
		else if (runChar === "~") longestTilde = Math.max(longestTilde, run);
	}
	const backtickLen = Math.max(3, longestBacktick + 1);
	const tildeLen = Math.max(3, longestTilde + 1);
	return tildeLen < backtickLen ? "~".repeat(tildeLen) : "`".repeat(backtickLen);
}

/** Lowercase ASCII slug from the task; ≤48 chars; fallback "context-export". */
function slugifyTask(task: string): string {
	const slug = task
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
	return slug || "context-export";
}

function buildDestination(task: string, now: Date): string {
	const iso = now.toISOString();
	const stamp = `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
	return `${CONTEXT_EXPORT_DIR}/${stamp}-${slugifyTask(task)}-${crypto.randomUUID().slice(0, 8)}.md`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Selection engine
// ═══════════════════════════════════════════════════════════════════════════

/** Concurrency for source-file reads. */
const READ_CONCURRENCY = 8;

interface InventoryFile {
	size: number;
	mtime?: number;
}

type SelectionKind = "base" | "directory" | "file";

interface FileSelectionState {
	/** "full" | merged intervals; empty array = not selected. */
	full: boolean;
	ranges: Interval[];
	/** What last put this file into a selected state. */
	selectedBy: SelectionKind;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new ContextExportError("publish-failed", "Context export was cancelled.");
	}
}

export async function prepareContextExport(options: PrepareContextExportOptions): Promise<PreparedContextExport> {
	const limits: ContextExportLimits = { ...CONTEXT_EXPORT_LIMITS, ...options.limits };
	const signal = options.signal;
	const task = options.task;
	if (task.trim().length === 0 || task !== task.trim()) {
		throw new ContextExportError("invalid-task", "Context export task must be non-empty trimmed text.");
	}
	if (task.length > CONTEXT_EXPORT_TASK_MAX_LENGTH) {
		throw new ContextExportError("invalid-task", CONTEXT_EXPORT_TASK_TOO_LONG_MESSAGE);
	}
	const { base, operations } = options.selection;
	if (base !== "all" && base !== "none") {
		throw new ContextExportError("invalid-selection", `Unknown selection base: ${String(base)}`);
	}
	if (operations.length > limits.maxSelectionOperations) {
		throw new ContextExportError(
			"limit-exceeded",
			`Selection has ${operations.length} operations; limit is ${limits.maxSelectionOperations}.`,
		);
	}
	const suppliedRangeCount = operations.reduce((n, op) => n + (op.ranges?.length ?? 0), 0);
	if (suppliedRangeCount > limits.maxSelectionRanges) {
		throw new ContextExportError(
			"limit-exceeded",
			`Selection supplies ${suppliedRangeCount} ranges; limit is ${limits.maxSelectionRanges}.`,
		);
	}

	// ── Inventory ────────────────────────────────────────────────────────────
	const rootPath = path.resolve(options.rootPath);
	const inventory = await listWorkspace({
		path: rootPath,
		maxDepth: 0xffff_ffff,
		hidden: true,
		gitignore: true,
		collectAgentsMd: true,
		signal,
	});
	if (inventory.truncated) {
		throw new ContextExportError(
			"inventory-truncated",
			`Repository inventory was truncated (native cap ${CONTEXT_EXPORT_INVENTORY_ENTRY_CAP} entries); refusing to present a partial repository as complete.`,
		);
	}
	// Native path order preserved via Map insertion order.
	const files = new Map<string, InventoryFile>();
	const dirs = new Set<string>();
	for (const entry of inventory.entries) {
		if (!isSafeRelativePosixPath(entry.path)) {
			throw new ContextExportError(
				"inventory-unsafe",
				`Inventory produced an unaddressable path: ${JSON.stringify(entry.path)}`,
			);
		}
		const firstComponent = entry.path.split("/", 1)[0];
		if (firstComponent === ".git" || firstComponent === CONTEXT_EXPORT_DIR) continue;
		if (entry.fileType === FileType.Dir) {
			dirs.add(entry.path);
		} else if (entry.fileType === FileType.File && !files.has(entry.path)) {
			files.set(entry.path, { size: entry.size ?? 0, mtime: entry.mtime });
		}
		// Symlinks and anything else are outside the selectable universe.
	}

	// ── Ordered selection program ────────────────────────────────────────────
	const states = new Map<string, FileSelectionState>();
	const stateOf = (relPath: string): FileSelectionState => {
		let state = states.get(relPath);
		if (!state) {
			state =
				base === "all"
					? { full: true, ranges: [], selectedBy: "base" }
					: { full: false, ranges: [], selectedBy: "base" };
			states.set(relPath, state);
		}
		return state;
	};

	let totalReadBytes = 0;
	const reads = new Map<string, SourceRead>();
	const readForSelection = async (relPath: string): Promise<SourceRead> => {
		const cached = reads.get(relPath);
		if (cached) return cached;
		throwIfAborted(signal);
		const meta = files.get(relPath);
		if (!meta) throw new ContextExportError("path-not-found", `No such file in inventory: ${relPath}`);
		if (meta.size > limits.maxSourceFileBytes) {
			throw new ContextExportError(
				"limit-exceeded",
				`${relPath} is ${meta.size} bytes; per-file limit is ${limits.maxSourceFileBytes}.`,
			);
		}
		totalReadBytes += meta.size;
		if (totalReadBytes > limits.maxTotalReadBytes) {
			throw new ContextExportError(
				"limit-exceeded",
				`Total source bytes exceed the ${limits.maxTotalReadBytes}-byte read budget.`,
			);
		}
		const read = await readSourceFile(path.join(rootPath, relPath), relPath, meta);
		reads.set(relPath, read);
		return read;
	};

	for (const [opIndex, op] of operations.entries()) {
		throwIfAborted(signal);
		const label = `operation ${opIndex + 1} (${op.action} ${JSON.stringify(op.path)})`;
		if (op.action !== "include" && op.action !== "exclude") {
			throw new ContextExportError("invalid-selection", `Unknown action in ${label}.`);
		}
		if (!isSafeRelativePosixPath(op.path)) {
			throw new ContextExportError("invalid-path", `Invalid repository-relative path in ${label}.`);
		}
		const isFile = files.has(op.path);
		const isDir = !isFile && dirs.has(op.path);
		// Deny before existence so an explicit op on a denied path never reveals
		// whether the file exists.
		if (!isDir && isDeniedContextExportPath(op.path)) {
			throw new ContextExportError("denied-path", `Refusing ${label}: path matches the sensitive-file denylist.`);
		}
		if (!isFile && !isDir) {
			throw new ContextExportError("path-not-found", `No inventoried file or directory matches ${label}.`);
		}
		if (op.ranges !== undefined) {
			if (!isFile) {
				throw new ContextExportError(
					"invalid-range",
					`Ranges are only valid on an exact file; ${label} targets a directory.`,
				);
			}
			if (op.ranges.length === 0) {
				throw new ContextExportError("invalid-range", `Empty ranges array in ${label}.`);
			}
			const read = await readForSelection(op.path);
			if (read.binary) {
				throw new ContextExportError("binary-file", `Cannot apply line ranges to binary file in ${label}.`);
			}
			const lineCount = read.lines.length;
			const intervals: Interval[] = [];
			for (const range of op.ranges) {
				const { startLine, endLine } = range;
				if (
					!Number.isInteger(startLine) ||
					!Number.isInteger(endLine) ||
					startLine < 1 ||
					endLine < startLine ||
					endLine > lineCount
				) {
					throw new ContextExportError(
						"invalid-range",
						`Invalid range ${startLine}-${endLine} in ${label}: file has ${lineCount} line${lineCount === 1 ? "" : "s"} (1-indexed inclusive, no clamping).`,
					);
				}
				intervals.push({ start: startLine, end: endLine });
			}
			const state = stateOf(op.path);
			if (op.action === "include") {
				if (!state.full) {
					state.ranges = mergeIntervals([...state.ranges, ...intervals]);
					state.selectedBy = "file";
				}
			} else {
				const removal = mergeIntervals(intervals);
				const baseRanges = state.full ? [{ start: 1, end: lineCount }] : state.ranges;
				state.full = false;
				state.ranges = subtractIntervals(mergeIntervals(baseRanges), removal);
			}
			if (state.ranges.length > limits.maxRangesPerFile) {
				throw new ContextExportError(
					"limit-exceeded",
					`${op.path} has ${state.ranges.length} normalized ranges; per-file limit is ${limits.maxRangesPerFile}.`,
				);
			}
			continue;
		}
		// Whole-file / directory operation.
		const targets: string[] = isFile ? [op.path] : [];
		if (isDir) {
			const prefix = `${op.path}/`;
			for (const filePath of files.keys()) {
				if (filePath.startsWith(prefix)) targets.push(filePath);
			}
		}
		for (const target of targets) {
			const state = stateOf(target);
			if (op.action === "include") {
				state.full = true;
				state.ranges = [];
				state.selectedBy = isFile ? "file" : "directory";
			} else {
				state.full = false;
				state.ranges = [];
			}
		}
	}

	// ── Resolve final selection in native inventory order ────────────────────
	interface SelectedFile {
		path: string;
		state: FileSelectionState;
	}
	const selected: SelectedFile[] = [];
	for (const filePath of files.keys()) {
		const state = base === "all" ? stateOf(filePath) : states.get(filePath);
		if (!state) continue;
		if (state.full || state.ranges.length > 0) selected.push({ path: filePath, state });
	}
	if (selected.length > limits.maxSelectedFiles) {
		throw new ContextExportError(
			"limit-exceeded",
			`Selection resolves to ${selected.length} files; limit is ${limits.maxSelectedFiles}.`,
		);
	}

	const skips: ContextExportSkip[] = [];
	const exportable: SelectedFile[] = [];
	for (const item of selected) {
		if (isDeniedContextExportPath(item.path)) {
			if (item.state.selectedBy === "file") {
				throw new ContextExportError(
					"denied-path",
					`Explicitly included file matches the sensitive-file denylist: ${item.path}`,
				);
			}
			skips.push({ path: item.path, reason: "sensitive path" });
			continue;
		}
		exportable.push(item);
	}

	// Read remaining full-selection files (ranged files are already cached).
	throwIfAborted(signal);
	const unread = exportable.filter(item => !reads.has(item.path));
	// Preflight budgets sequentially (deterministic), then read concurrently.
	for (const item of unread) {
		const meta = files.get(item.path)!;
		if (meta.size > limits.maxSourceFileBytes) {
			throw new ContextExportError(
				"limit-exceeded",
				`${item.path} is ${meta.size} bytes; per-file limit is ${limits.maxSourceFileBytes}.`,
			);
		}
		totalReadBytes += meta.size;
		if (totalReadBytes > limits.maxTotalReadBytes) {
			throw new ContextExportError(
				"limit-exceeded",
				`Total source bytes exceed the ${limits.maxTotalReadBytes}-byte read budget.`,
			);
		}
	}
	const { results: unreadResults } = await mapWithConcurrencyLimit(
		unread,
		READ_CONCURRENCY,
		item => readSourceFile(path.join(rootPath, item.path), item.path, files.get(item.path)!),
		signal,
	);
	for (const [i, read] of unreadResults.entries()) {
		if (read instanceof Error) throw read;
		reads.set(unread[i].path, read as SourceRead);
	}

	interface RenderFile {
		path: string;
		read: SourceRead;
		state: FileSelectionState;
	}
	const renderFiles: RenderFile[] = [];
	for (const item of exportable) {
		const read = reads.get(item.path)!;
		if (read.binary) {
			if (item.state.selectedBy === "file") {
				throw new ContextExportError("binary-file", `Explicitly included file is binary: ${item.path}`);
			}
			skips.push({ path: item.path, reason: "binary file" });
			continue;
		}
		renderFiles.push({ path: item.path, read, state: item.state });
	}
	if (renderFiles.length === 0) {
		throw new ContextExportError("empty-selection", "Selection resolves to no exportable file content.");
	}

	// ── Secret detection (configured/environment secrets only) ───────────────
	const detector = options.secretDetector;
	const detects = (text: string): boolean => detector !== undefined && detector.obfuscate(text) !== text;
	const destination = buildDestination(task, options.now ?? new Date());
	if (detector?.hasSecrets()) {
		const hits: string[] = [];
		if (detects(task)) hits.push("task");
		if (detects(destination)) hits.push("destination");
		for (const [opIndex, op] of operations.entries()) {
			// Operation paths render in the selection-program manifest even when
			// the file itself is excluded or never selected.
			if (detects(op.path)) hits.push(`operation ${opIndex + 1} path`);
		}
		// A path that itself matched must never be echoed in the error: fall back
		// to an ordinal label so the message carries no secret value.
		const fileLabels = new Map<string, string>();
		for (const [index, file] of renderFiles.entries()) {
			const pathMatched = detects(file.path);
			fileLabels.set(file.path, pathMatched ? `selected file #${index + 1}` : file.path);
			if (pathMatched) hits.push(`selected file #${index + 1} path`);
		}
		for (const [index, skip] of skips.entries()) {
			if (detects(skip.path)) hits.push(`skipped file #${index + 1} path`);
		}
		for (const file of renderFiles) {
			const label = fileLabels.get(file.path) ?? file.path;
			if (file.state.full) {
				if (detects(file.read.content)) hits.push(`content of ${label}`);
			} else {
				for (const range of file.state.ranges) {
					const slice = file.read.lines.slice(range.start - 1, range.end).join("");
					if (detects(slice)) hits.push(`content of ${label} lines ${range.start}-${range.end}`);
				}
			}
		}
		if (hits.length > 0) {
			throw new ContextExportError(
				"secret-detected",
				`A configured or environment secret matched the export. Affected: ${hits.join("; ")}. Change the selection or move the secret out of the exported content.`,
				{ hits },
			);
		}
	}

	// ── Render ────────────────────────────────────────────────────────────────
	const payloadBytes = new Map<string, number>();
	let sourceBytes = 0;
	const fullFiles: Record<string, unknown>[] = [];
	const slicedFiles: Record<string, unknown>[] = [];
	let sliceRangeCount = 0;
	for (const file of renderFiles) {
		const language = getLanguageFromPath(file.path) ?? "text";
		const pathJson = JSON.stringify(file.path);
		if (file.state.full) {
			const body = file.read.content;
			const bytes = Buffer.byteLength(body, "utf8");
			payloadBytes.set(file.path, bytes);
			sourceBytes += bytes;
			const endsWithNewline = body.endsWith("\n");
			fullFiles.push({
				pathJson,
				language,
				lineCount: file.read.lines.length,
				endsWithNewline,
				fence: chooseFence(body),
				bodyBlock: body.length === 0 || endsWithNewline ? body : `${body}\n`,
			});
		} else {
			const lineCount = file.read.lines.length;
			let bytes = 0;
			const ranges = file.state.ranges.map(range => {
				sliceRangeCount++;
				const body = file.read.lines.slice(range.start - 1, range.end).join("");
				bytes += Buffer.byteLength(body, "utf8");
				const endsWithNewline = body.endsWith("\n");
				const touchesEof = range.end === lineCount;
				return {
					start: range.start,
					end: range.end,
					language,
					// Terminal-newline metadata only matters for the range holding EOF.
					note: touchesEof ? `; terminal newline: ${endsWithNewline}` : "",
					fence: chooseFence(body),
					bodyBlock: body.length === 0 || endsWithNewline ? body : `${body}\n`,
				};
			});
			payloadBytes.set(file.path, bytes);
			sourceBytes += bytes;
			slicedFiles.push({ pathJson, language, lineCount, ranges });
		}
	}

	const taskJson = JSON.stringify(task);
	const skipGroups = new Map<string, string[]>();
	for (const skip of skips) {
		let group = skipGroups.get(skip.reason);
		if (!group) {
			group = [];
			skipGroups.set(skip.reason, group);
		}
		group.push(JSON.stringify(skip.path));
	}
	const context = {
		generatedAt: (options.now ?? new Date()).toISOString(),
		taskJson,
		taskFence: chooseFence(taskJson),
		selectionBase: base,
		inventory: {
			entryCount: inventory.entries.length,
			fileCount: files.size,
			dirCount: dirs.size,
			entryCap: CONTEXT_EXPORT_INVENTORY_ENTRY_CAP,
		},
		operations: operations.map((op, index) => ({
			index: index + 1,
			action: op.action,
			pathJson: JSON.stringify(op.path),
			rangesText: op.ranges?.map(r => `${r.startLine}-${r.endLine}`).join(", ") ?? "",
		})),
		effective: renderFiles.map(file => ({
			pathJson: JSON.stringify(file.path),
			mode: file.state.full ? "full" : `lines ${file.state.ranges.map(r => `${r.start}-${r.end}`).join(", ")}`,
		})),
		skipGroups: [...skipGroups.entries()].map(([reason, paths]) => ({ reason, paths })),
		fullFiles,
		slicedFiles,
		stats: {
			selectedFileCount: renderFiles.length,
			fullFileCount: fullFiles.length,
			slicedFileCount: slicedFiles.length,
			sliceRangeCount,
		},
	};
	// prompt.compile, NOT prompt.render: the post-render formatter would trim
	// trailing whitespace inside fenced payloads and corrupt exact snapshots.
	const markdown = prompt.compile(outputTemplate)(context);

	// Catch-all over the exact rendered bytes, BEFORE any diagnostics that echo
	// metadata (the budget error lists payload paths): nothing the itemized
	// scan missed may leak through an error message.
	if (detector?.hasSecrets() && detects(markdown)) {
		throw new ContextExportError(
			"secret-detected",
			"A configured or environment secret matched the rendered bundle. Change the selection or move the secret out of the exported content.",
		);
	}

	const largestPayloads = [...payloadBytes.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 20)
		.map(([p, bytes]) => ({ path: p, bytes }));
	const renderedBytes = Buffer.byteLength(markdown, "utf8");
	const tokens = countTokens(markdown);
	if (tokens > limits.maxTokens) {
		const offenders = largestPayloads.map(p => `${p.path} (${p.bytes} bytes)`).join(", ");
		throw new ContextExportError(
			"token-budget",
			`Rendered bundle is ${tokens} o200k_base tokens; limit is ${limits.maxTokens}. Source ${sourceBytes} bytes, rendered ${renderedBytes} bytes. Largest selected payloads: ${offenders}.`,
			{ tokens, maxTokens: limits.maxTokens, sourceBytes, renderedBytes, largestPayloads },
		);
	}

	return {
		rootPath,
		destination,
		markdown,
		stats: {
			inventoryEntryCount: inventory.entries.length,
			inventoryFileCount: files.size,
			inventoryDirCount: dirs.size,
			selectedFileCount: renderFiles.length,
			fullFileCount: fullFiles.length,
			slicedFileCount: slicedFiles.length,
			sliceRangeCount,
			sourceBytes,
			renderedBytes,
			tokens,
			maxTokens: limits.maxTokens,
			tokenHeadroom: limits.maxTokens - tokens,
		},
		skips,
		largestPayloads,
		secretScan: detector ? "clean" : "skipped",
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Publication
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Atomically publish the cached bundle: exclusive temp at 0600 inside
 * `prompt-exports/` (created 0700 when absent), hard-link to the absent final
 * path, remove the temp. Never overwrites; any failure cleans the temp,
 * preserves an existing destination, and surfaces a content-free error.
 */
export async function publishContextExport(
	prepared: PreparedContextExport,
	signal?: AbortSignal,
): Promise<ContextExportWriteResult> {
	const dir = path.join(prepared.rootPath, CONTEXT_EXPORT_DIR);
	const fail = (reason: string): never => {
		throw new ContextExportError("publish-failed", `Context export publication failed: ${reason}`);
	};
	try {
		const st = await fs.lstat(dir);
		if (st.isSymbolicLink() || !st.isDirectory()) {
			fail(`${CONTEXT_EXPORT_DIR} exists but is not a real directory.`);
		}
	} catch (err) {
		if (err instanceof ContextExportError) throw err;
		if (!isEnoent(err)) fail("cannot inspect the output directory.");
		try {
			await fs.mkdir(dir, { mode: 0o700 });
		} catch {
			fail("cannot create the output directory.");
		}
	}
	const tempPath = path.join(dir, `.context-export-${crypto.randomUUID()}.tmp`);
	const finalPath = path.join(prepared.rootPath, prepared.destination);
	let handle: fs.FileHandle | undefined;
	try {
		throwIfAborted(signal);
		handle = await fs.open(tempPath, "wx", 0o600);
		await handle.writeFile(prepared.markdown, "utf8");
		await handle.close();
		handle = undefined;
		throwIfAborted(signal);
		await fs.link(tempPath, finalPath);
	} catch (err) {
		await handle?.close().catch(() => {});
		await fs.unlink(tempPath).catch(() => {});
		if (err instanceof ContextExportError) throw err;
		const code = errnoCode(err);
		if (code === "EEXIST") {
			fail("the destination already exists; the existing file was left untouched.");
		}
		fail("the filesystem rejected atomic no-overwrite publication.");
	}
	await fs.unlink(tempPath).catch(() => {});
	return {
		destination: prepared.destination,
		bytesWritten: Buffer.byteLength(prepared.markdown, "utf8"),
		tokens: prepared.stats.tokens,
		sourceBytes: prepared.stats.sourceBytes,
	};
}
