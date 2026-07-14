import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApproval,
} from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { getAgentDir, prompt } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import { type SessionsServerHandle, startSessionsServer } from "../cli/sessions-server";
import type { Settings } from "../config/settings";
import tuiObserveDescription from "../prompts/tools/tui-observe.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { getBashTuiSnapshot, listBashTuiSnapshots } from "../session/bash-tui-snapshots";
import { cmuxSurfaceIdFor, diffRenderedText, readCmuxScreen } from "../session/cmux-capture";
import { readLiveEvents } from "../session/live-event-stream";
import {
	inspectLiveSession,
	type LiveSessionSummary,
	listLiveSessions,
	listOmpProcessSessions,
} from "../session/live-session-registry";
import { captureNativeTerminal, type NativeCaptureOutcome } from "../session/native-terminal-capture";
import { readTerminalSnapshot } from "../session/terminal-snapshot";
import { resizeImage } from "../utils/image-resize";
import { acquireBrowser } from "./browser/registry";
import type { ScreenshotResult } from "./browser/tab-protocol";
import { acquireTab, releaseTab, runInTab } from "./browser/tab-supervisor";
import type { OutputMeta } from "./output-meta";
import { expandPath } from "./path-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

const MAX_SNAPSHOT_TEXT = 20_000;
const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 500;
const MAX_DIFF_ROWS = 40;
const MAX_DIFF_ROW_CHARS = 400;

const tuiObserveSchema = z.object({
	action: z
		.enum([
			"list",
			"snapshot",
			"events",
			"mirror",
			"screenshot",
			"native_screenshot",
			"emulator_screen",
			"render_diff",
			"bash_snapshots",
		])
		.default("snapshot")
		.describe("Observation action. Defaults to a read-only snapshot of the current session."),
	run: z
		.string()
		.optional()
		.describe("Run id from `list`. Defaults to the current session or the only running session."),
	limit: z
		.number()
		.int()
		.positive()
		.max(MAX_EVENT_LIMIT)
		.optional()
		.describe(
			"Max recent events for the events action; for emulator_screen, only the last N lines (includes scrollback).",
		),
	running: z.boolean().optional().describe("For list: only include running sessions."),
	rows: z
		.string()
		.optional()
		.describe(
			'For screenshot: terminal row range to crop or highlight, e.g. "4" or "4-9" (matches data-terminal-row).',
		),
	cols: z
		.string()
		.optional()
		.describe('For screenshot: column (cell index) range within the selected rows, e.g. "10-40". Requires rows.'),
	selector: z
		.string()
		.optional()
		.describe(
			"For screenshot: raw CSS selector to crop or highlight instead of rows/cols (mutually exclusive with rows).",
		),
	highlight: z
		.boolean()
		.optional()
		.describe("For screenshot: outline the region on a full-page capture instead of cropping to it."),
});

/** Input schema for the tui_observe tool. */
export type TuiObserveParams = z.infer<typeof tuiObserveSchema>;

export interface TuiObserveDetails {
	action: TuiObserveParams["action"];
	meta?: OutputMeta;
	runId?: string;
	screenshotPath?: string;
	screenshotSource?: "mirror" | "native-terminal";
	mirrorUrl?: string;
}

export interface MirrorRegion {
	rows?: readonly [number, number];
	cols?: readonly [number, number];
	selector?: string;
	highlight?: boolean;
}

export interface MirrorSelectionInfo {
	rows?: readonly [number, number];
	cols?: readonly [number, number];
	selector?: string;
	text: string;
}

export interface MirrorScreenshotResult {
	path: string;
	mimeType: string;
	bytes: number;
	width: number;
	height: number;
	url: string;
	displays: Array<TextContent | ImageContent>;
	selection?: MirrorSelectionInfo;
}

let sharedMirror: { agentDir: string; handle: SessionsServerHandle } | undefined;

/** Lazily start (and cache) the loopback mirror server for an agent directory. */
export function getSharedMirror(agentDir: string): SessionsServerHandle {
	if (sharedMirror?.agentDir === agentDir) return sharedMirror.handle;
	sharedMirror?.handle.stop();
	const handle = startSessionsServer({ agentDir });
	sharedMirror = { agentDir, handle };
	return handle;
}

/** Stop and clear the shared mirror server (used for process/test teardown). */
export function stopSharedMirror(): void {
	sharedMirror?.handle.stop();
	sharedMirror = undefined;
}

/**
 * Resolve an absolute PNG destination for a TUI screenshot.
 * Mirror captures prefer `tui.screenshotDir` then `browser.screenshotDir`; native
 * captures additionally prefer `tui.nativeCapture.screenshotDir` first. Falls back to a temp file.
 */
export function resolveTuiScreenshotDest(
	settings: Settings,
	kind: "mirror" | "native",
	runId: string,
	now: () => Date = () => new Date(),
): string {
	const candidates =
		kind === "native"
			? [
					settings.get("tui.nativeCapture.screenshotDir"),
					settings.get("tui.screenshotDir"),
					settings.get("browser.screenshotDir"),
				]
			: [settings.get("tui.screenshotDir"), settings.get("browser.screenshotDir")];
	const configured = candidates.find((value): value is string => typeof value === "string" && value.length > 0);
	const base = configured ? expandPath(configured) : os.tmpdir();
	const stamp = now()
		.toISOString()
		.replace(/[^0-9]/gu, "")
		.slice(0, 14);
	const safeRun = runId.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 48) || "session";
	return path.join(base, `omp-tui-${safeRun}-${kind}-${stamp}.png`);
}

const REGION_OVERLAY_ID = "__omp_sel_overlay";

/**
 * Page-context function (serialized onto the mirror's photo page) that resolves a
 * selection to its DOM elements, computes the union bounding box in document
 * coordinates, injects a positioned overlay (`#__omp_sel_overlay`) used as the
 * crop/highlight anchor, and returns the selected text. A crop capture
 * screenshots the transparent overlay; a highlight capture outlines it on a full-page shot.
 */
const REGION_SELECT_PAGE_FN = `(s) => {
	const prev = document.getElementById(${JSON.stringify(REGION_OVERLAY_ID)});
	if (prev) prev.remove();
	const els = [];
	let text = "";
	if (s.selector) {
		const el = document.querySelector(s.selector);
		if (el) { els.push(el); text = el.getAttribute("data-text") || el.textContent || ""; }
	} else if (s.rows) {
		for (let r = s.rows[0]; r <= s.rows[1]; r++) {
			const row = document.querySelector('[data-terminal-row="' + r + '"]');
			if (!row) continue;
			const rowText = row.getAttribute("data-text") || "";
			if (s.cols) {
				const cells = row.querySelectorAll("[data-terminal-cell]");
				for (let c = s.cols[0]; c <= s.cols[1] && c < cells.length; c++) els.push(cells[c]);
				text += rowText.slice(s.cols[0], s.cols[1] + 1) + "\\n";
			} else { els.push(row); text += rowText + "\\n"; }
		}
	}
	if (els.length === 0) return { ok: false };
	let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
	for (const el of els) {
		const rc = el.getBoundingClientRect();
		left = Math.min(left, rc.left + window.scrollX);
		top = Math.min(top, rc.top + window.scrollY);
		right = Math.max(right, rc.right + window.scrollX);
		bottom = Math.max(bottom, rc.bottom + window.scrollY);
	}
	const ov = document.createElement("div");
	ov.id = ${JSON.stringify(REGION_OVERLAY_ID)};
	ov.style.position = "absolute";
	ov.style.left = left + "px";
	ov.style.top = top + "px";
	ov.style.width = (right - left) + "px";
	ov.style.height = (bottom - top) + "px";
	ov.style.pointerEvents = "none";
	ov.style.zIndex = "2147483647";
	ov.style.background = "transparent";
	if (s.highlight) { ov.style.outline = "2px solid #ff3b30"; ov.style.boxShadow = "0 0 0 9999px rgba(0,0,0,0.45)"; }
	document.body.appendChild(ov);
	return { ok: true, text: text.replace(/\\n+$/, ""), rect: { x: left, y: top, width: right - left, height: bottom - top } };
}`;

/** Build the `runInTab` code string that selects a region then captures it. */
export function buildRegionScreenshotCode(region: MirrorRegion, destPath: string): string {
	const spec = {
		rows: region.rows ?? null,
		cols: region.cols ?? null,
		selector: region.selector ?? null,
		highlight: region.highlight ?? false,
	};
	const shot = region.highlight
		? `{ fullPage: true, save: ${JSON.stringify(destPath)} }`
		: `{ selector: ${JSON.stringify(`#${REGION_OVERLAY_ID}`)}, save: ${JSON.stringify(destPath)} }`;
	return `const __sel = await tab.evaluate(${REGION_SELECT_PAGE_FN}, ${JSON.stringify(spec)});
if (!__sel || !__sel.ok) return { ok: false };
await tab.screenshot(${shot});
return __sel;`;
}

/** Describe a region for error messages. */
function describeRegion(region: MirrorRegion): string {
	if (region.selector) return `selector ${JSON.stringify(region.selector)}`;
	const rows = region.rows ? `rows ${region.rows[0]}-${region.rows[1]}` : "rows ?";
	return region.cols ? `${rows}, cols ${region.cols[0]}-${region.cols[1]}` : rows;
}

/** Parse a `"N"` or `"N-M"` range into an inclusive numeric pair. */
function parseRowRange(value: string, label: string): readonly [number, number] {
	const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/u.exec(value);
	if (!match) throw new ToolError(`Invalid ${label} range ${JSON.stringify(value)} (use "N" or "N-M").`);
	const start = Number(match[1]);
	const end = match[2] !== undefined ? Number(match[2]) : start;
	if (end < start) throw new ToolError(`Invalid ${label} range ${JSON.stringify(value)} (start greater than end).`);
	return [start, end];
}

/** Resolve screenshot region params into a `MirrorRegion`, or undefined for a full-page capture. */
export function parseScreenshotRegion(
	params: Pick<TuiObserveParams, "rows" | "cols" | "selector" | "highlight">,
): MirrorRegion | undefined {
	const hasRows = typeof params.rows === "string" && params.rows.length > 0;
	const hasSelector = typeof params.selector === "string" && params.selector.length > 0;
	const hasCols = typeof params.cols === "string" && params.cols.length > 0;
	if (!hasRows && !hasSelector) {
		if (hasCols) throw new ToolError("`cols` requires `rows`.");
		if (params.highlight) throw new ToolError("`highlight` requires `rows` or `selector`.");
		return undefined;
	}
	if (hasRows && hasSelector) throw new ToolError("Use either `rows` or `selector`, not both.");
	if (hasCols && !hasRows) throw new ToolError("`cols` requires `rows`.");
	const region: MirrorRegion = {};
	if (params.highlight) region.highlight = true;
	if (hasSelector) region.selector = params.selector;
	if (hasRows) region.rows = parseRowRange(params.rows as string, "rows");
	if (hasCols) region.cols = parseRowRange(params.cols as string, "cols");
	return region;
}

/** Capture the run's terminal through the loopback mirror's photo view and save a PNG. */
export async function captureMirrorScreenshot(options: {
	session: ToolSession;
	mirrorUrl: string;
	runId: string;
	destPath: string;
	timeoutMs: number;
	signal?: AbortSignal;
	region?: MirrorRegion;
}): Promise<MirrorScreenshotResult> {
	const photoUrl = `${options.mirrorUrl}/sessions?run=${encodeURIComponent(options.runId)}&mode=photo`;
	await fs.mkdir(path.dirname(options.destPath), { recursive: true });
	const browser = await acquireBrowser(
		{ kind: "headless", headless: true },
		{ cwd: options.session.cwd, signal: options.signal },
	);
	const tabName = `tui-observe:${options.runId}`;
	try {
		await acquireTab(tabName, browser, {
			url: photoUrl,
			waitUntil: "networkidle0",
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
		const code = options.region
			? buildRegionScreenshotCode(options.region, options.destPath)
			: `await tab.screenshot({ fullPage: true, save: ${JSON.stringify(options.destPath)} }); return null;`;
		const result = await runInTab(tabName, {
			code,
			timeoutMs: options.timeoutMs,
			signal: options.signal,
			session: options.session,
		});
		const shot: ScreenshotResult | undefined = result.screenshots[0];
		if (!shot) {
			const ret = result.returnValue as { ok?: boolean } | null;
			if (options.region && (!ret || ret.ok === false)) {
				throw new ToolError(`TUI region matched no cells (${describeRegion(options.region)}).`);
			}
			throw new ToolError("Mirror screenshot did not produce an image.");
		}
		let selection: MirrorSelectionInfo | undefined;
		if (options.region) {
			const ret = result.returnValue as { ok: boolean; text?: string } | null;
			selection = {
				rows: options.region.rows,
				cols: options.region.cols,
				selector: options.region.selector,
				text: ret?.text ?? "",
			};
		}
		return {
			path: shot.dest,
			mimeType: shot.mimeType,
			bytes: shot.bytes,
			width: shot.width,
			height: shot.height,
			url: photoUrl,
			displays: result.displays,
			selection,
		};
	} finally {
		await releaseTab(tabName, { kill: false });
	}
}

/**
 * Load a captured screenshot back as an inline image block, downscaled to the
 * same budget the browser screenshot pipeline uses. Attaching it to the tool
 * result makes the TUI render it in the session, so the user sees exactly what
 * the model received. Returns undefined instead of failing a capture that
 * already succeeded when the file cannot be read or decoded.
 *
 * A preview reflects what was actually captured, so resizing may only shrink it:
 * `minDimension: 1` overrides the shared resizer's vision-backend floor (which
 * upscales sub-200px inputs) so a tiny capture — e.g. a 1x1 render — is passed
 * through at its real size instead of being blown up to a fabricated 200px.
 */
export async function inlineScreenshotImage(filePath: string): Promise<ImageContent | undefined> {
	try {
		const buffer = await fs.readFile(filePath);
		const resized = await resizeImage(
			{ type: "image", data: buffer.toBase64(), mimeType: "image/png" },
			{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70, minDimension: 1 },
		);
		return { type: "image", data: resized.data, mimeType: resized.mimeType };
	} catch {
		return undefined;
	}
}

export class TuiObserveTool implements AgentTool<typeof tuiObserveSchema, TuiObserveDetails> {
	readonly name = "tui_observe";
	readonly label = "TUI Observe";
	readonly loadMode = "discoverable" as const;
	readonly summary = "Inspect live OMP terminal sessions (DOM-like state, events, screenshots, emulator diffs)";
	readonly parameters = tuiObserveSchema;
	readonly approval: ToolApproval = (args: unknown) => {
		const action = (args as Partial<TuiObserveParams> | undefined)?.action;
		return action === "screenshot" || action === "native_screenshot" ? "exec" : "read";
	};

	constructor(private readonly session: ToolSession) {}
	#description?: string;
	get description(): string {
		this.#description ??= prompt.render(tuiObserveDescription, {});
		return this.#description;
	}

	async execute(
		_toolCallId: string,
		params: TuiObserveParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TuiObserveDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<TuiObserveDetails>> {
		const agentDir = getAgentDir();
		switch (params.action) {
			case "list":
				return await this.#list(agentDir, params);
			case "snapshot":
				return await this.#snapshot(agentDir, params);
			case "events":
				return await this.#events(agentDir, params);
			case "mirror":
				return await this.#mirror(agentDir, params);
			case "screenshot":
				return await this.#screenshot(agentDir, params, signal);
			case "native_screenshot":
				return await this.#nativeScreenshot(agentDir, params);
			case "emulator_screen":
				return await this.#emulatorScreen(agentDir, params);
			case "render_diff":
				return await this.#renderDiff(agentDir, params);
			case "bash_snapshots":
				return this.#bashSnapshots(params);
		}
	}

	async #list(agentDir: string, params: TuiObserveParams): Promise<AgentToolResult<TuiObserveDetails>> {
		const sessions = await listLiveSessions({ agentDir, runningOnly: params.running });
		const payload = sessions.map(session => ({
			runId: session.runId,
			source: session.source,
			status: session.status,
			isRunning: session.isRunning,
			pid: session.pid,
			cmuxSurfaceId: session.cmuxSurfaceId,
			mode: session.mode,
			model: session.model,
			cwd: session.cwd || undefined,
			command: session.command,
		}));
		return toolResult<TuiObserveDetails>({ action: params.action })
			.text(JSON.stringify({ sessions: payload }, null, 2))
			.done();
	}

	async #snapshot(agentDir: string, params: TuiObserveParams): Promise<AgentToolResult<TuiObserveDetails>> {
		const session = await this.#resolveSession(agentDir, params.run);
		const terminal = session.terminalSnapshotPath ? await readTerminalSnapshot(session.terminalSnapshotPath) : null;
		const text = terminal ? boundedText(terminal.text) : null;
		const payload = {
			runId: session.runId,
			source: session.source,
			status: session.status,
			isRunning: session.isRunning,
			pid: session.pid,
			cmuxSurfaceId: session.cmuxSurfaceId,
			cwd: session.cwd || undefined,
			model: session.model,
			heartbeatAt: session.heartbeatAt,
			terminal: terminal
				? {
						capturedAt: terminal.capturedAt,
						cols: terminal.cols,
						rows: terminal.rows,
						cursor: {
							x: terminal.cursorX,
							y: terminal.cursorY,
							visible: terminal.cursorVisible,
							style: terminal.cursorStyle,
						},
						text,
					}
				: null,
		};
		return toolResult<TuiObserveDetails>({ action: params.action, runId: session.runId })
			.text(JSON.stringify(payload, null, 2))
			.done();
	}

	async #events(agentDir: string, params: TuiObserveParams): Promise<AgentToolResult<TuiObserveDetails>> {
		const session = await this.#resolveSession(agentDir, params.run);
		if (!session.eventStreamPath) {
			throw new ToolError(`Session ${session.runId} is process-only and has no recorded event stream.`);
		}
		const limit = params.limit && params.limit > 0 ? Math.min(params.limit, MAX_EVENT_LIMIT) : DEFAULT_EVENT_LIMIT;
		const { records } = await readLiveEvents(session.eventStreamPath);
		const recent = records.slice(-limit);
		return toolResult<TuiObserveDetails>({ action: params.action, runId: session.runId })
			.text(JSON.stringify({ runId: session.runId, events: recent }, null, 2))
			.done();
	}

	async #mirror(agentDir: string, params: TuiObserveParams): Promise<AgentToolResult<TuiObserveDetails>> {
		const session = await this.#resolveSession(agentDir, params.run);
		const mirror = getSharedMirror(agentDir);
		const url = `${mirror.url}/sessions?run=${encodeURIComponent(session.runId)}`;
		return toolResult<TuiObserveDetails>({ action: params.action, runId: session.runId, mirrorUrl: url })
			.text(JSON.stringify({ runId: session.runId, mirrorUrl: url, photoUrl: `${url}&mode=photo` }, null, 2))
			.done();
	}

	async #screenshot(
		agentDir: string,
		params: TuiObserveParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<TuiObserveDetails>> {
		const session = await this.#resolveSession(agentDir, params.run);
		const mirror = getSharedMirror(agentDir);
		const destPath = resolveTuiScreenshotDest(this.session.settings, "mirror", session.runId);
		const timeoutMs = clampTimeout("browser", undefined) * 1000;
		const region = parseScreenshotRegion(params);
		const capture = await captureMirrorScreenshot({
			session: this.session,
			mirrorUrl: mirror.url,
			runId: session.runId,
			destPath,
			timeoutMs,
			signal,
			region,
		});
		const summary = JSON.stringify(
			{
				runId: session.runId,
				screenshot: { path: capture.path, mimeType: capture.mimeType, bytes: capture.bytes, source: "mirror" },
				url: capture.url,
				selection: capture.selection,
			},
			null,
			2,
		);
		const content: Array<TextContent | ImageContent> = [{ type: "text", text: summary }, ...capture.displays];
		return toolResult<TuiObserveDetails>({
			action: params.action,
			runId: session.runId,
			screenshotPath: capture.path,
			screenshotSource: "mirror",
		})
			.content(content)
			.done();
	}

	async #nativeScreenshot(agentDir: string, params: TuiObserveParams): Promise<AgentToolResult<TuiObserveDetails>> {
		const session = await this.#resolveSession(agentDir, params.run);
		const settings = this.session.settings;
		const destPath = resolveTuiScreenshotDest(settings, "native", session.runId);
		await fs.mkdir(path.dirname(destPath), { recursive: true });
		const outcome: NativeCaptureOutcome = await captureNativeTerminal({
			enabled: settings.get("tui.nativeCapture.enabled"),
			destPath,
			preferredApp: settings.get("tui.nativeCapture.preferredApp"),
			includeWindowChrome: settings.get("tui.nativeCapture.includeWindowChrome"),
			pid: session.pid,
		});
		if (!outcome.ok) {
			throw new ToolError(`Native terminal capture failed (${outcome.reason}): ${outcome.message}`);
		}
		const inlineImage = await inlineScreenshotImage(outcome.result.path);
		const summary = JSON.stringify(
			{
				runId: session.runId,
				screenshot: outcome.result,
				hint: inlineImage
					? "The attached image is a downscaled preview (also rendered in the session for the user); use inspect_image on the full-resolution screenshot path for fine detail."
					: "Use inspect_image on the screenshot path for visual analysis without inlining the full-resolution image.",
			},
			null,
			2,
		);
		const content: Array<TextContent | ImageContent> = [{ type: "text", text: summary }];
		if (inlineImage) content.push(inlineImage);
		return toolResult<TuiObserveDetails>({
			action: params.action,
			runId: session.runId,
			screenshotPath: outcome.result.path,
			screenshotSource: "native-terminal",
		})
			.content(content)
			.done();
	}

	/** Read the text the terminal emulator actually rendered for the run's cmux surface. */
	async #emulatorScreen(agentDir: string, params: TuiObserveParams): Promise<AgentToolResult<TuiObserveDetails>> {
		const session = await this.#resolveSession(agentDir, params.run);
		const surfaceId = cmuxSurfaceIdFor(session);
		if (!surfaceId) {
			throw new ToolError(
				`Session ${session.runId} has no cmux surface id; emulator capture needs the session to run inside cmux.`,
			);
		}
		const outcome = await readCmuxScreen({ surfaceId, lines: params.limit });
		if (!outcome.ok) {
			throw new ToolError(`Emulator screen read failed (${outcome.reason}): ${outcome.message}`);
		}
		const payload = {
			runId: session.runId,
			surfaceId,
			source: outcome.result.source,
			text: boundedText(outcome.result.text),
		};
		return toolResult<TuiObserveDetails>({ action: params.action, runId: session.runId })
			.text(JSON.stringify(payload, null, 2))
			.done();
	}

	/** Diff the internal snapshot (renderer's belief) against the emulator's rendered text. */
	async #renderDiff(agentDir: string, params: TuiObserveParams): Promise<AgentToolResult<TuiObserveDetails>> {
		const session = await this.#resolveSession(agentDir, params.run);
		const surfaceId = cmuxSurfaceIdFor(session);
		if (!surfaceId) {
			throw new ToolError(
				`Session ${session.runId} has no cmux surface id; render_diff needs the session to run inside cmux.`,
			);
		}
		const terminal = session.terminalSnapshotPath ? await readTerminalSnapshot(session.terminalSnapshotPath) : null;
		if (!terminal) {
			throw new ToolError(`Session ${session.runId} has no internal terminal snapshot to diff against.`);
		}
		const outcome = await readCmuxScreen({ surfaceId });
		if (!outcome.ok) {
			throw new ToolError(`Emulator screen read failed (${outcome.reason}): ${outcome.message}`);
		}
		const diff = diffRenderedText(terminal.text, outcome.result.text);
		const capRow = (row: string) => (row.length > MAX_DIFF_ROW_CHARS ? `${row.slice(0, MAX_DIFF_ROW_CHARS)}…` : row);
		const payload = {
			runId: session.runId,
			surfaceId,
			identical: diff.identical,
			scrollOffset: diff.scrollOffset,
			rowsCompared: diff.rowsCompared,
			matchedRows: diff.matchedRows,
			internal: {
				capturedAt: terminal.capturedAt,
				ageMs: Math.max(0, Date.now() - Date.parse(terminal.capturedAt)),
				cols: terminal.cols,
				rows: diff.internalRows,
			},
			emulator: { rows: diff.emulatorRows },
			mismatchedRows: diff.mismatches.length,
			mismatches: diff.mismatches.slice(0, MAX_DIFF_ROWS).map(entry => ({
				row: entry.row,
				internal: capRow(entry.internal),
				emulator: capRow(entry.emulator),
			})),
		};
		return toolResult<TuiObserveDetails>({ action: params.action, runId: session.runId })
			.text(JSON.stringify(payload, null, 2))
			.done();
	}

	#bashSnapshots(params: TuiObserveParams): AgentToolResult<TuiObserveDetails> {
		if (params.run) {
			const record = getBashTuiSnapshot(params.run);
			if (!record) {
				throw new ToolError(`Bash TUI snapshot ${params.run} not found.`);
			}
			const payload = {
				id: record.id,
				command: record.command,
				cwd: record.cwd,
				exitCode: record.exitCode,
				cancelled: record.cancelled,
				timedOut: record.timedOut,
				capturedAt: record.capturedAt,
				cols: record.snapshot.cols,
				rows: record.snapshot.rows,
				text: boundedText(record.snapshot.text),
			};
			return toolResult<TuiObserveDetails>({ action: params.action })
				.text(JSON.stringify(payload, null, 2))
				.done();
		}
		const snapshots = listBashTuiSnapshots().map(record => ({
			id: record.id,
			command: record.command,
			cwd: record.cwd,
			exitCode: record.exitCode,
			cancelled: record.cancelled,
			timedOut: record.timedOut,
			capturedAt: record.capturedAt,
			cols: record.snapshot.cols,
			rows: record.snapshot.rows,
			preview: previewText(record.snapshot.text),
		}));
		return toolResult<TuiObserveDetails>({ action: params.action })
			.text(JSON.stringify({ snapshots }, null, 2))
			.done();
	}

	async #resolveSession(agentDir: string, run: string | undefined): Promise<LiveSessionSummary> {
		if (run) {
			const registered = await inspectLiveSession(agentDir, run);
			if (registered) return registered;
			const processSession = (await listOmpProcessSessions()).find(candidate => candidate.runId === run);
			if (processSession) return processSession;
			throw new ToolError(`Session ${run} not found. Use tui_observe action "list" to see run ids.`);
		}
		const running = await listLiveSessions({ agentDir, runningOnly: true, includeProcessFallback: false });
		const current = running.find(candidate => candidate.pid === process.pid);
		if (current) return current;
		if (running.length === 1) return running[0]!;
		if (running.length === 0) throw new ToolError("No running OMP sessions found.");
		throw new ToolError(
			`Multiple running sessions found; pass run: ${running.map(candidate => candidate.runId).join(", ")}`,
		);
	}
}

function boundedText(text: string): string {
	return text.length > MAX_SNAPSHOT_TEXT ? `${text.slice(0, MAX_SNAPSHOT_TEXT)}\n… (truncated)` : text;
}

const PREVIEW_TEXT_CHARS = 800;

function previewText(text: string): string {
	const tail = text.length > PREVIEW_TEXT_CHARS ? text.slice(text.length - PREVIEW_TEXT_CHARS) : text;
	return text.length > PREVIEW_TEXT_CHARS ? `…${tail}` : tail;
}
