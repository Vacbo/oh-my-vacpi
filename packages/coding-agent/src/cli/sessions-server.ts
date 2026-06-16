import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { readLiveEvents } from "../session/live-event-stream";
import {
	inspectLiveSession,
	type LiveSessionSummary,
	listLiveSessions,
	listOmpProcessSessions,
} from "../session/live-session-registry";
import { readTerminalSnapshot, type TerminalSnapshot, terminalColorToCss } from "../session/terminal-snapshot";
import { handleTuiControlInput } from "../session/tui-control";

export interface SessionsServerOptions {
	agentDir?: string;
	hostname?: string;
	port?: number;
}

export interface SessionsServerHandle {
	url: string;
	stop(): void;
}

export interface SessionPayload {
	session: LiveSessionSummary | null;
	terminal: TerminalSnapshot | null;
}

const STREAM_POLL_MS = 500;
const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 1_000;

export function startSessionsServer(options: SessionsServerOptions = {}): SessionsServerHandle {
	const agentDir = options.agentDir ?? getAgentDir();
	const hostname = options.hostname ?? "127.0.0.1";
	const server = Bun.serve({
		hostname,
		port: options.port ?? 0,
		async fetch(request) {
			return await handleSessionsRequest(request, agentDir);
		},
	});
	return {
		url: `http://${hostname}:${server.port}`,
		stop() {
			server.stop();
		},
	};
}

async function handleSessionsRequest(request: Request, agentDir: string): Promise<Response> {
	const url = new URL(request.url);

	const apiMatch = /^\/api\/sessions\/([^/]+)(?:\/(events|terminal|stream|input))?$/u.exec(url.pathname);
	if (apiMatch) {
		const runId = decodeURIComponent(apiMatch[1]!);
		const sub = apiMatch[2];
		if (sub === "input") return await handleControlInput(request, runId);
		if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
		if (sub === "stream") return streamSession(agentDir, runId, request.signal);
		const session = await resolveSummary(agentDir, runId);
		if (!session) return json({ error: "Session not found" }, 404);
		if (sub === "terminal") {
			const terminal = session.terminalSnapshotPath
				? await readTerminalSnapshot(session.terminalSnapshotPath)
				: null;
			return json({ runId, terminal });
		}
		if (sub === "events") {
			const limit = clampLimit(url.searchParams.get("limit"));
			const records = session.eventStreamPath ? (await readLiveEvents(session.eventStreamPath)).records : [];
			return json({ runId, events: records.slice(-limit) });
		}
		const terminal = session.terminalSnapshotPath ? await readTerminalSnapshot(session.terminalSnapshotPath) : null;
		return json({ session, terminal } satisfies SessionPayload);
	}

	if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

	if (url.pathname === "/api/sessions") {
		return json(await listLiveSessions({ agentDir }));
	}

	if (url.pathname === "/" || url.pathname === "/sessions") {
		const sessions = await listLiveSessions({ agentDir });
		const runId = url.searchParams.get("run") ?? sessions[0]?.runId;
		const payload = runId ? await buildSessionPayload(agentDir, runId) : { session: null, terminal: null };
		const photo = url.searchParams.get("mode") === "photo";
		const body = photo
			? renderPhotoPage(payload.session, payload.terminal)
			: renderSessionsPage(sessions, payload.session, payload.terminal);
		return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
	}

	return new Response("Not Found", { status: 404 });
}

async function handleControlInput(request: Request, runId: string): Promise<Response> {
	if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
	let body: { data?: unknown; token?: unknown };
	try {
		body = (await request.json()) as { data?: unknown; token?: unknown };
	} catch {
		return json({ status: "error", message: "Expected a JSON body with a `data` string." }, 400);
	}
	const data = typeof body.data === "string" ? body.data : "";
	const token = typeof body.token === "string" ? body.token : undefined;
	const settings = await Settings.init();
	const result = handleTuiControlInput({ runId, data, token, settings });
	const httpStatus = result.status === "ok" ? 200 : result.status === "not-found" ? 404 : 403;
	return json({ status: result.status, message: result.message }, httpStatus);
}

function streamSession(agentDir: string, runId: string, signal: AbortSignal): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let byteOffset = 0;
			let lastCapturedAt = "";
			const emit = (event: string, data: unknown): void => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					closed = true;
				}
			};
			const tick = async (): Promise<void> => {
				if (closed) return;
				const session = await resolveSummary(agentDir, runId);
				if (!session) {
					emit("error", { error: "Session not found" });
					return;
				}
				if (session.terminalSnapshotPath) {
					const terminal = await readTerminalSnapshot(session.terminalSnapshotPath);
					if (terminal && terminal.capturedAt !== lastCapturedAt) {
						lastCapturedAt = terminal.capturedAt;
						emit("terminal", terminal);
					}
				}
				if (session.eventStreamPath) {
					const result = await readLiveEvents(session.eventStreamPath, byteOffset);
					byteOffset = result.nextByte;
					for (const record of result.records) emit("event", record);
				}
				emit("session", session);
			};
			const interval = setInterval(() => {
				void tick().catch(() => {});
			}, STREAM_POLL_MS);
			interval.unref?.();
			const stop = (): void => {
				if (closed) return;
				closed = true;
				clearInterval(interval);
				try {
					controller.close();
				} catch {
					// already closed
				}
			};
			signal.addEventListener("abort", stop);
			void tick().catch(() => {});
		},
	});
	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
	});
}

async function resolveSummary(agentDir: string, runId: string): Promise<LiveSessionSummary | null> {
	const registered = await inspectLiveSession(agentDir, runId);
	if (registered) return registered;
	return (await listOmpProcessSessions()).find(candidate => candidate.runId === runId) ?? null;
}

async function buildSessionPayload(agentDir: string, runId: string): Promise<SessionPayload> {
	const session = await resolveSummary(agentDir, runId);
	return {
		session,
		terminal: session?.terminalSnapshotPath ? await readTerminalSnapshot(session.terminalSnapshotPath) : null,
	};
}

function clampLimit(raw: string | null): number {
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EVENT_LIMIT;
	return Math.min(parsed, MAX_EVENT_LIMIT);
}

function json(value: unknown, status = 200): Response {
	return new Response(`${JSON.stringify(value, null, 2)}\n`, {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
	});
}

// Nerd Font families come after the system monos: browsers fall back per glyph, so
// icon/powerline codepoints resolve against an installed patched font instead of tofu.
const TERMINAL_FONT_STACK = `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Symbols Nerd Font Mono", "Symbols Nerd Font", "JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "FiraCode Nerd Font Mono", "FiraCode Nerd Font", "Hack Nerd Font Mono", "Hack Nerd Font", "MesloLGS NF", monospace`;

// Cell backgrounds must be painted by full-height boxes on an integer-pixel row
// grid. Inline spans only paint the font's content area (ascent+descent), which
// is shorter than the line box, so tinted blocks leak the page background as
// 1-2px horizontal bands between rows; a fractional em row pitch (1.35em) adds
// subpixel seams on top. Inline-block cells pinned to an integer row height tile
// seamlessly, and vertical-align: top keeps fallback-font metrics (Nerd Font
// icons, emoji) from shifting baselines and growing line boxes past the grid row.
// Font size is tied to row pitch: box-drawing glyphs (U+2500-257F) come from the
// font, not procedural drawing like a real terminal, and they only span the font's
// natural line height (~1.286em for Menlo). At 14px in a 19px row a vertical `│`
// covers 18 of 19px, breaking table borders with a 1px seam at every row boundary.
// 15px spans ~19.3px >= the row, and .terminal-row's overflow: hidden crops the
// ~0.15px excess, so vertical strokes fuse across rows (measured: longest unbroken
// border stroke went from 36 to 497 device px at DPR 2).
function terminalStyle(options: { fontPx: number; rowPx: number; frame: boolean; animate: boolean }): string {
	const row = `${options.rowPx}px`;
	const frame = options.frame ? " border: 1px solid #263241; border-radius: .6rem; overflow: auto;" : "";
	const blink = options.animate
		? "\n.cell.blink { animation: cell-blink 1s steps(2, start) infinite; }\n@keyframes cell-blink { 50% { opacity: 0; } }"
		: "";
	return `.terminal { font: ${options.fontPx}px/${row} ${TERMINAL_FONT_STACK}; background: #05070a; padding: 1rem;${frame} }
.terminal-grid { display: grid; grid-auto-rows: ${row}; }
.terminal-row { white-space: pre; height: ${row}; overflow: hidden; }
.cell { display: inline-block; height: ${row}; vertical-align: top; }
.cell.bold { font-weight: 700; }
.cell.dim { opacity: .6; }
.cell.italic { font-style: italic; }
.cell.underline { text-decoration: underline; }
.cell.strikethrough { text-decoration: line-through; }
.cell.underline.strikethrough { text-decoration: underline line-through; }
.cell.overline { text-decoration: overline; }
.cell.inverse { filter: invert(1); }
.cell.invisible { visibility: hidden; }${blink}
.sr-text { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }`;
}

const PAGE_STYLE = `:root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #0b0f14; color: #e6edf3; }
body { margin: 0; display: grid; grid-template-columns: 20rem 1fr; min-height: 100vh; }
aside { border-right: 1px solid #263241; padding: 1rem; background: #111822; }
main { padding: 1rem; overflow: auto; }
a { color: inherit; text-decoration: none; }
.session { display: block; padding: .6rem .7rem; margin-bottom: .5rem; border: 1px solid #263241; border-radius: .5rem; }
.session[aria-current="page"] { border-color: #58a6ff; background: #13233a; }
.status { font-size: .75rem; color: #8b949e; }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: .35rem .75rem; margin-bottom: 1rem; }
.meta dt { color: #8b949e; }
.meta dd { margin: 0; overflow-wrap: anywhere; }
${terminalStyle({ fontPx: 15, rowPx: 19, frame: true, animate: true })}
.omp-sel-box { position: fixed; border: 1px solid #58a6ff; background: rgba(88,166,255,0.18); pointer-events: none; z-index: 2147483646; }
.omp-sel-readout { position: fixed; right: 1rem; bottom: 1rem; max-width: 28rem; padding: .7rem .8rem; background: #111822; border: 1px solid #58a6ff; border-radius: .5rem; font-size: .8rem; z-index: 2147483647; box-shadow: 0 6px 24px rgba(0,0,0,.5); }
.omp-sel-title { font-weight: 600; margin-bottom: .4rem; }
.omp-sel-cmd { display: block; font-family: ui-monospace, monospace; color: #79c0ff; word-break: break-all; margin-bottom: .4rem; }
.omp-sel-copy { font: inherit; cursor: pointer; padding: .2rem .5rem; margin-bottom: .4rem; background: #1f6feb; color: #fff; border: none; border-radius: .35rem; }
.omp-sel-text { white-space: pre-wrap; max-height: 8rem; overflow: auto; margin: 0; color: #c9d1d9; background: #0b0f14; padding: .4rem; border-radius: .35rem; }`;

const PHOTO_STYLE = `:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #05070a; color: #e6edf3; }
${terminalStyle({ fontPx: 15, rowPx: 19, frame: false, animate: false })}`;

// Drag-select overlay for the human-viewable mirror page only (never the photo page,
// which must stay free of overlays so region screenshots crop cleanly). The user drags
// a box over the grid; the script resolves the covered `data-terminal-row` rows and the
// intersected `data-terminal-cell` column span, then surfaces the matching
// `tui_observe screenshot rows=…/cols=…` invocation plus the selected text to copy.
const SELECT_OVERLAY_SCRIPT = `(() => {
	const snapshot = document.querySelector("[data-terminal-snapshot]");
	if (!snapshot) return;
	const runEl = document.querySelector('[data-field="runId"]');
	const runId = runEl ? (runEl.textContent || "") : "";
	let box = null;
	let readout = null;
	let startX = 0, startY = 0, dragging = false;
	function ensureReadout() {
		if (!readout) {
			readout = document.createElement("div");
			readout.className = "omp-sel-readout";
			document.body.appendChild(readout);
		}
		return readout;
	}
	function update(e) {
		const left = Math.min(startX, e.clientX);
		const top = Math.min(startY, e.clientY);
		const width = Math.abs(e.clientX - startX);
		const height = Math.abs(e.clientY - startY);
		if (box) {
			box.style.left = left + "px";
			box.style.top = top + "px";
			box.style.width = width + "px";
			box.style.height = height + "px";
		}
		return { left: left, top: top, right: left + width, bottom: top + height, width: width, height: height };
	}
	function finish(rect) {
		const rows = [];
		for (const row of snapshot.querySelectorAll("[data-terminal-row]")) {
			const r = row.getBoundingClientRect();
			if (r.bottom >= rect.top && r.top <= rect.bottom) rows.push(row);
		}
		if (rows.length === 0) return;
		let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity;
		for (const row of rows) {
			const n = Number(row.getAttribute("data-terminal-row"));
			if (n < minRow) minRow = n;
			if (n > maxRow) maxRow = n;
			const cells = row.querySelectorAll("[data-terminal-cell]");
			for (let i = 0; i < cells.length; i++) {
				const c = cells[i].getBoundingClientRect();
				if (c.right < rect.left || c.left > rect.right) continue;
				if (i < minCol) minCol = i;
				if (i > maxCol) maxCol = i;
			}
		}
		const cols = minCol <= maxCol ? [minCol, maxCol] : null;
		let text = "";
		for (const row of rows) {
			const rowText = row.getAttribute("data-text") || "";
			text += (cols ? rowText.slice(cols[0], cols[1] + 1) : rowText) + "\\n";
		}
		text = text.replace(/\\n+$/, "");
		const rowsArg = minRow === maxRow ? String(minRow) : minRow + "-" + maxRow;
		const colsArg = cols ? (cols[0] === cols[1] ? String(cols[0]) : cols[0] + "-" + cols[1]) : "";
		let cmd = "tui_observe screenshot";
		if (runId) cmd += ' run="' + runId + '"';
		cmd += ' rows="' + rowsArg + '"';
		if (colsArg) cmd += ' cols="' + colsArg + '"';
		const panel = ensureReadout();
		panel.innerHTML = "";
		const title = document.createElement("div");
		title.className = "omp-sel-title";
		title.textContent = "Selection: rows " + rowsArg + (colsArg ? ", cols " + colsArg : "");
		const code = document.createElement("code");
		code.className = "omp-sel-cmd";
		code.textContent = cmd;
		const copy = document.createElement("button");
		copy.className = "omp-sel-copy";
		copy.textContent = "Copy command";
		copy.addEventListener("click", () => {
			if (navigator.clipboard) navigator.clipboard.writeText(cmd);
			copy.textContent = "Copied";
			setTimeout(() => { copy.textContent = "Copy command"; }, 1200);
		});
		const pre = document.createElement("pre");
		pre.className = "omp-sel-text";
		pre.textContent = text;
		panel.appendChild(title);
		panel.appendChild(code);
		panel.appendChild(copy);
		panel.appendChild(pre);
	}
	snapshot.addEventListener("mousedown", (e) => {
		if (e.button !== 0) return;
		dragging = true;
		startX = e.clientX;
		startY = e.clientY;
		box = document.createElement("div");
		box.className = "omp-sel-box";
		document.body.appendChild(box);
		update(e);
		e.preventDefault();
	});
	window.addEventListener("mousemove", (e) => { if (dragging) update(e); });
	window.addEventListener("mouseup", (e) => {
		if (!dragging) return;
		dragging = false;
		const rect = update(e);
		if (box) { box.remove(); box = null; }
		if (rect.width > 2 && rect.height > 2) finish(rect);
	});
})();`;

function renderSessionsPage(
	sessions: LiveSessionSummary[],
	session: LiveSessionSummary | null,
	terminal: TerminalSnapshot | null,
): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OMP Sessions</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<aside>
<h1>OMP Sessions</h1>
${sessions.map(item => renderSessionLink(item, session?.runId)).join("\n")}
</aside>
<main>
${session ? renderSessionDetail(session, terminal) : "<p>No live sessions found.</p>"}
</main>
${session ? `<script>${SELECT_OVERLAY_SCRIPT}</script>` : ""}
</body>
</html>`;
}

function renderPhotoPage(session: LiveSessionSummary | null, terminal: TerminalSnapshot | null): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OMP Terminal${session ? ` · ${escapeHtml(session.runId)}` : ""}</title>
<style>${PHOTO_STYLE}</style>
</head>
<body>
${renderTerminal(terminal)}
</body>
</html>`;
}

function renderSessionLink(session: LiveSessionSummary, activeRunId: string | undefined): string {
	const active = session.runId === activeRunId ? ' aria-current="page"' : "";
	return `<a class="session"${active} href="/sessions?run=${encodeURIComponent(session.runId)}"><strong>${escapeHtml(session.agentId)}</strong><br><span class="status">${escapeHtml(session.status)} · pid ${session.pid}</span></a>`;
}

function renderSessionDetail(session: LiveSessionSummary, terminal: TerminalSnapshot | null): string {
	return `<h2>${escapeHtml(session.agentId)}</h2>
<dl class="meta" data-session-metadata>
<dt>Run</dt><dd data-field="runId">${escapeHtml(session.runId)}</dd>
<dt>Status</dt><dd data-field="status">${escapeHtml(session.status)}</dd>
<dt>CWD</dt><dd data-field="cwd">${escapeHtml(session.cwd)}</dd>
<dt>Model</dt><dd data-field="model">${escapeHtml(session.model ?? "")}</dd>
<dt>Session file</dt><dd data-field="sessionFile">${escapeHtml(session.sessionFile ?? "")}</dd>
</dl>
${renderTerminal(terminal)}`;
}

function renderTerminal(terminal: TerminalSnapshot | null): string {
	return `<section class="terminal" aria-label="Terminal snapshot" data-terminal-snapshot>
<div class="sr-text" data-terminal-text>${escapeHtml(terminal?.text ?? "")}</div>
${renderCursor(terminal)}
<div class="terminal-grid" role="table" aria-rowcount="${terminal?.lines.length ?? 0}">
${terminal ? terminal.lines.map(renderTerminalLine).join("\n") : "<div>No terminal snapshot captured yet.</div>"}
</div>
</section>`;
}

function renderCursor(terminal: TerminalSnapshot | null): string {
	if (!terminal) return "";
	return `<div data-cursor data-x="${terminal.cursorX}" data-y="${terminal.cursorY}" data-visible="${terminal.cursorVisible}" data-style="${escapeAttribute(terminal.cursorStyle)}" hidden></div>`;
}

function renderTerminalLine(line: TerminalSnapshot["lines"][number]): string {
	const cells = line.cells.length > 0 ? line.cells.map(renderTerminalCell).join("") : escapeHtml(line.text);
	return `<div class="terminal-row" role="row" data-terminal-row="${line.row}" data-text="${escapeAttribute(line.text)}">${cells}</div>`;
}

function renderTerminalCell(cell: TerminalSnapshot["lines"][number]["cells"][number]): string {
	const classes = ["cell"];
	if (cell.bold) classes.push("bold");
	if (cell.dim) classes.push("dim");
	if (cell.italic) classes.push("italic");
	if (cell.underline) classes.push("underline");
	if (cell.strikethrough) classes.push("strikethrough");
	if (cell.overline) classes.push("overline");
	if (cell.blink) classes.push("blink");
	if (cell.inverse) classes.push("inverse");
	if (cell.invisible) classes.push("invisible");
	const style = `${cell.fg ? `color:${terminalColorToCss(cell.fg)};` : ""}${cell.bg ? `background-color:${terminalColorToCss(cell.bg)};` : ""}`;
	return `<span class="${classes.join(" ")}" data-terminal-cell${style ? ` style="${style}"` : ""}>${escapeHtml(cell.text)}</span>`;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"]/gu, char => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return char;
		}
	});
}

function escapeAttribute(value: string): string {
	return escapeHtml(value).replace(/\n/gu, "&#10;");
}
