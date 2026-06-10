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
import { Process, type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";
import { encodeKey, type KeyId } from "@oh-my-pi/pi-tui";
import { getAgentDir, prompt } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import tuiDriveDescription from "../prompts/tools/tui-drive.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { diffRenderedText } from "../session/cmux-capture";
import { inspectLiveSession, listLiveSessions } from "../session/live-session-registry";
import { readTerminalSnapshot, TerminalSnapshotRecorder } from "../session/terminal-snapshot";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";
import { captureMirrorScreenshot, getSharedMirror, resolveTuiScreenshotDest } from "./tui-observe";

const MAX_DRIVE_SESSIONS = 4;
const MAX_SNAPSHOT_TEXT = 20_000;
const MAX_DIFF_ROWS = 40;
const MAX_DIFF_ROW_CHARS = 400;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 35;
const DEFAULT_DEBOUNCE_MS = 250;
const MAX_DEBOUNCE_MS = 5_000;
const DEFAULT_WAIT_TIMEOUT_MS = 3_000;
const MAX_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_LIFETIME_MS = 900_000;
const MIN_LIFETIME_MS = 10_000;
const MAX_LIFETIME_MS = 3_600_000;
const IDLE_POLL_MS = 50;
const TEXT_POLL_MS = 100;
const CORRELATE_TIMEOUT_MS = 10_000;
const CORRELATE_POLL_MS = 500;
/** startedAt slack when matching a registry session to a drive spawn. */
const CORRELATE_START_SLACK_MS = 2_000;

/** Terminal-identity env that must not leak into driven children (stale cmux
 * surface ids poison emulator reads; kitty-capable TERM_PROGRAMs would flip
 * the child out of the legacy keyboard mode encodeKey targets). */
const SCRUB_ENV_PREFIXES = ["CMUX_", "KITTY_", "GHOSTTY_", "ITERM_", "WEZTERM_"];
const SCRUB_ENV_KEYS = new Set(["TMUX", "TMUX_PANE", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"]);

interface DriveSession {
	id: string;
	command: string;
	cwd: string;
	cols: number;
	rows: number;
	startedAt: number;
	pty: PtySession;
	recorder: TerminalSnapshotRecorder;
	lastOutputAt: number;
	/** Settles when the PTY command exits (resolves even on PTY errors). */
	done: Promise<PtyRunResult>;
	exit?: PtyRunResult;
	/** Registry run id of the driven omp child, once correlated. */
	ompRunId?: string;
}

const driveSessions = new Map<string, DriveSession>();
let driveSessionCounter = 0;

/** Kill every drive session and drop all records (test/process teardown). */
export function disposeAllTuiDriveSessions(): void {
	for (const session of driveSessions.values()) {
		if (!session.exit) {
			try {
				session.pty.kill();
			} catch {
				// already gone
			}
		}
		session.recorder.dispose();
	}
	driveSessions.clear();
}

function buildDriveEnv(extra: Record<string, string> | undefined): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (SCRUB_ENV_KEYS.has(key) || SCRUB_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
		env[key] = value;
	}
	env.TERM = "xterm-256color";
	env.COLORTERM = "truecolor";
	// Caller-provided entries win, including over the scrub and TERM defaults.
	if (extra) Object.assign(env, extra);
	return env;
}

function startDriveSession(options: {
	command: string;
	cwd: string;
	cols: number;
	rows: number;
	env?: Record<string, string>;
	lifetimeMs: number;
	shell?: string;
}): DriveSession {
	if (driveSessions.size >= MAX_DRIVE_SESSIONS) {
		throw new ToolError(
			`Too many drive sessions (max ${MAX_DRIVE_SESSIONS}). Kill one first: ${[...driveSessions.keys()].join(", ")}`,
		);
	}
	driveSessionCounter += 1;
	const id = `drive-${driveSessionCounter}`;
	const pty = new PtySession();
	const recorder = new TerminalSnapshotRecorder({
		path: path.join(os.tmpdir(), `omp-tui-drive-${id}.json`),
		cols: options.cols,
		rows: options.rows,
		// Forward emulator replies (DA1/DSR query answers) back into the PTY so
		// full-screen apps waiting on terminal queries don't stall.
		onData: data => {
			try {
				pty.write(data);
			} catch {
				// command already exited
			}
		},
	});
	const session: DriveSession = {
		id,
		command: options.command,
		cwd: options.cwd,
		cols: options.cols,
		rows: options.rows,
		startedAt: Date.now(),
		pty,
		recorder,
		lastOutputAt: Date.now(),
		done: Promise.resolve({ exitCode: undefined, cancelled: false, timedOut: false }),
	};
	session.done = pty
		.start(
			{
				command: options.command,
				cwd: options.cwd,
				env: buildDriveEnv(options.env),
				// The PTY merges env over the parent's by default; the scrub only
				// works when the child env is exactly what buildDriveEnv returns.
				envClear: true,
				cols: options.cols,
				rows: options.rows,
				timeoutMs: options.lifetimeMs,
				shell: options.shell,
			},
			(err, chunk) => {
				if (err || !chunk) return;
				recorder.write(chunk);
				session.lastOutputAt = Date.now();
			},
		)
		.catch((error): PtyRunResult => {
			recorder.write(`\r\nPTY error: ${error instanceof Error ? error.message : String(error)}\r\n`);
			return { exitCode: undefined, cancelled: false, timedOut: false };
		})
		.then(result => {
			session.exit = result;
			return result;
		});
	driveSessions.set(id, session);
	return session;
}

/** Resolve when no output has arrived for `debounceMs`, or at the deadline. */
async function waitForIdle(session: DriveSession, debounceMs: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (session.exit) return;
		if (Date.now() - session.lastOutputAt >= debounceMs) return;
		await Bun.sleep(IDLE_POLL_MS);
	}
}

/** Poll the rendered screen for a regex; deadline is not an error (mirrors tui-use). */
async function waitForText(session: DriveSession, pattern: string, timeoutMs: number): Promise<boolean> {
	let regex: RegExp;
	try {
		regex = new RegExp(pattern);
	} catch (error) {
		throw new ToolError(`Invalid waitText regex: ${error instanceof Error ? error.message : String(error)}`);
	}
	const deadline = Date.now() + timeoutMs;
	while (true) {
		await session.recorder.flush();
		if (regex.test(session.recorder.snapshot().text)) return true;
		if (session.exit || Date.now() >= deadline) {
			await session.recorder.flush();
			return regex.test(session.recorder.snapshot().text);
		}
		await Bun.sleep(TEXT_POLL_MS);
	}
}

/** Pids of every descendant of this process (the PTY shell and its children). */
function collectDescendantPids(): Set<number> {
	const pids = new Set<number>();
	const root = Process.fromPid(process.pid);
	if (!root) return pids;
	const queue: Process[] = [root];
	while (queue.length > 0) {
		const current = queue.pop()!;
		for (const child of current.children()) {
			if (pids.has(child.pid)) continue;
			pids.add(child.pid);
			queue.push(child);
		}
	}
	return pids;
}

/**
 * Bind the drive session to the registry run id of the omp child it spawned:
 * a running registry session whose pid is our descendant, cwd matches, and
 * which started no earlier than the drive spawn (minus clock slack).
 */
async function resolveOmpRunId(session: DriveSession): Promise<string> {
	if (session.ompRunId) return session.ompRunId;
	const agentDir = getAgentDir();
	const deadline = Date.now() + CORRELATE_TIMEOUT_MS;
	while (true) {
		const bound = new Set<string>();
		for (const other of driveSessions.values()) {
			if (other.id !== session.id && other.ompRunId) bound.add(other.ompRunId);
		}
		const descendants = collectDescendantPids();
		const candidates = (await listLiveSessions({ agentDir, runningOnly: true, includeProcessFallback: false }))
			.filter(
				summary =>
					descendants.has(summary.pid) &&
					summary.cwd === session.cwd &&
					Date.parse(summary.startedAt) >= session.startedAt - CORRELATE_START_SLACK_MS &&
					!bound.has(summary.runId),
			)
			.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
		const match = candidates[0];
		if (match) {
			session.ompRunId = match.runId;
			return match.runId;
		}
		if (session.exit || Date.now() >= deadline) {
			throw new ToolError(
				`No registered omp session found for drive session ${session.id}; screenshot/diff require driving an omp instance — use action "screen" for plain-text output.`,
			);
		}
		await Bun.sleep(CORRELATE_POLL_MS);
	}
}

const tuiDriveSchema = z.object({
	action: z
		.enum(["start", "input", "wait", "screen", "screenshot", "diff", "resize", "kill", "list"])
		.default("screen")
		.describe("Drive action. Defaults to reading the current screen."),
	session: z.string().optional().describe("Drive session id from `start`/`list`. Defaults to the only live session."),
	command: z.string().optional().describe("For start: shell command to spawn in the PTY (required)."),
	cwd: z.string().optional().describe("For start: working directory. Defaults to the agent's cwd."),
	cols: z.number().int().optional().describe(`PTY columns for start (default ${DEFAULT_COLS}) or resize (required).`),
	rows: z.number().int().optional().describe(`PTY rows for start (default ${DEFAULT_ROWS}) or resize (required).`),
	env: z.record(z.string(), z.string()).optional().describe("For start: extra environment variables (caller wins)."),
	text: z
		.string()
		.optional()
		.describe('For input: literal text to type. Every "\\n" is sent as Enter (carriage return).'),
	keys: z
		.array(z.string())
		.optional()
		.describe('For input: key names sent after text, e.g. ["enter", "ctrl+c", "up", "shift+tab"].'),
	waitText: z.string().optional().describe("For wait: regex tested against the rendered screen text."),
	timeoutMs: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			`For wait: deadline (default ${DEFAULT_WAIT_TIMEOUT_MS}, max ${MAX_WAIT_TIMEOUT_MS}). For start: session lifetime (default ${DEFAULT_LIFETIME_MS}).`,
		),
	debounceMs: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			`Output-idle window before returning the screen (default ${DEFAULT_DEBOUNCE_MS}, max ${MAX_DEBOUNCE_MS}).`,
		),
});

/** Input schema for the tui_drive tool. */
export type TuiDriveParams = z.infer<typeof tuiDriveSchema>;

export interface TuiDriveDetails {
	action: TuiDriveParams["action"];
	meta?: OutputMeta;
	session?: string;
	runId?: string;
	screenshotPath?: string;
}

const EXEC_ACTIONS: ReadonlySet<string> = new Set(["start", "input", "resize", "kill", "screenshot"]);

export class TuiDriveTool implements AgentTool<typeof tuiDriveSchema, TuiDriveDetails> {
	readonly name = "tui_drive";
	readonly label = "TUI Drive";
	readonly loadMode = "discoverable" as const;
	readonly summary =
		"Drive TUI programs in a PTY: spawn, send keys, wait, read the screen, screenshot driven omp sessions";
	readonly parameters = tuiDriveSchema;
	readonly approval: ToolApproval = (args: unknown) => {
		const action = (args as Partial<TuiDriveParams> | undefined)?.action;
		return action && EXEC_ACTIONS.has(action) ? "exec" : "read";
	};

	constructor(private readonly session: ToolSession) {}
	#description?: string;
	get description(): string {
		this.#description ??= prompt.render(tuiDriveDescription, {});
		return this.#description;
	}

	async execute(
		_toolCallId: string,
		params: TuiDriveParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TuiDriveDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<TuiDriveDetails>> {
		switch (params.action) {
			case "start":
				return await this.#start(params);
			case "input":
				return await this.#input(params);
			case "wait":
				return await this.#wait(params);
			case "screen":
				return await this.#screen(params);
			case "screenshot":
				return await this.#screenshot(params, signal);
			case "diff":
				return await this.#diff(params);
			case "resize":
				return await this.#resize(params);
			case "kill":
				return await this.#kill(params);
			case "list":
				return this.#list(params);
		}
	}

	#resolve(params: TuiDriveParams): DriveSession {
		if (params.session) {
			const found = driveSessions.get(params.session);
			if (!found) {
				const known = [...driveSessions.keys()].join(", ") || "none";
				throw new ToolError(`Drive session ${params.session} not found. Active sessions: ${known}.`);
			}
			return found;
		}
		const all = [...driveSessions.values()];
		const live = all.filter(candidate => !candidate.exit);
		if (live.length === 1) return live[0]!;
		if (all.length === 1) return all[0]!;
		if (all.length === 0) throw new ToolError('No drive sessions. Use action "start" first.');
		throw new ToolError(`Multiple drive sessions; pass session: ${all.map(candidate => candidate.id).join(", ")}`);
	}

	#debounce(params: TuiDriveParams): number {
		return Math.min(params.debounceMs ?? DEFAULT_DEBOUNCE_MS, MAX_DEBOUNCE_MS);
	}

	async #screenPayload(session: DriveSession): Promise<Record<string, unknown>> {
		await session.recorder.flush();
		const snapshot = session.recorder.snapshot();
		return {
			session: session.id,
			status: session.exit ? "exited" : "running",
			...(session.exit
				? { exitCode: session.exit.exitCode, cancelled: session.exit.cancelled, timedOut: session.exit.timedOut }
				: {}),
			cols: snapshot.cols,
			rows: snapshot.rows,
			cursor: { x: snapshot.cursorX, y: snapshot.cursorY, visible: snapshot.cursorVisible },
			text:
				snapshot.text.length > MAX_SNAPSHOT_TEXT
					? `${snapshot.text.slice(0, MAX_SNAPSHOT_TEXT)}\n… (truncated)`
					: snapshot.text,
		};
	}

	#result(
		params: TuiDriveParams,
		session: DriveSession,
		payload: Record<string, unknown>,
	): AgentToolResult<TuiDriveDetails> {
		return toolResult<TuiDriveDetails>({ action: params.action, session: session.id, runId: session.ompRunId })
			.text(JSON.stringify(payload, null, 2))
			.done();
	}

	async #start(params: TuiDriveParams): Promise<AgentToolResult<TuiDriveDetails>> {
		if (!params.command) throw new ToolError('Action "start" requires a command.');
		const lifetimeMs = Math.min(Math.max(params.timeoutMs ?? DEFAULT_LIFETIME_MS, MIN_LIFETIME_MS), MAX_LIFETIME_MS);
		const session = startDriveSession({
			command: params.command,
			cwd: params.cwd ?? this.session.cwd,
			cols: params.cols ?? DEFAULT_COLS,
			rows: params.rows ?? DEFAULT_ROWS,
			env: params.env,
			lifetimeMs,
			shell: this.session.settings.getShellConfig().shell,
		});
		await waitForIdle(session, this.#debounce(params), 5_000);
		const payload = {
			command: session.command,
			cwd: session.cwd,
			lifetimeMs,
			...(await this.#screenPayload(session)),
		};
		return this.#result(params, session, payload);
	}

	async #input(params: TuiDriveParams): Promise<AgentToolResult<TuiDriveDetails>> {
		const session = this.#resolve(params);
		if (session.exit) throw new ToolError(`Drive session ${session.id} has exited.`);
		if (!params.text && (!params.keys || params.keys.length === 0)) {
			throw new ToolError('Action "input" requires text and/or keys.');
		}
		if (params.text) {
			session.pty.write(params.text.replaceAll("\n", "\r"));
		}
		for (const key of params.keys ?? []) {
			let encoded: string;
			try {
				encoded = encodeKey(key as KeyId);
			} catch (error) {
				throw new ToolError(
					`Cannot encode key ${JSON.stringify(key)}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			session.pty.write(encoded);
		}
		// Restart the debounce window: idleness must be measured from the input,
		// not from whenever the app last produced output before it.
		session.lastOutputAt = Date.now();
		await waitForIdle(session, this.#debounce(params), 2_000);
		return this.#result(params, session, await this.#screenPayload(session));
	}

	async #wait(params: TuiDriveParams): Promise<AgentToolResult<TuiDriveDetails>> {
		const session = this.#resolve(params);
		const timeoutMs = Math.min(params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS);
		let timedOut = false;
		if (params.waitText) {
			timedOut = !(await waitForText(session, params.waitText, timeoutMs));
		} else {
			await waitForIdle(session, this.#debounce(params), timeoutMs);
		}
		const payload = { timedOut, ...(await this.#screenPayload(session)) };
		return this.#result(params, session, payload);
	}

	async #screen(params: TuiDriveParams): Promise<AgentToolResult<TuiDriveDetails>> {
		const session = this.#resolve(params);
		return this.#result(params, session, await this.#screenPayload(session));
	}

	async #screenshot(params: TuiDriveParams, signal?: AbortSignal): Promise<AgentToolResult<TuiDriveDetails>> {
		const session = this.#resolve(params);
		const runId = await resolveOmpRunId(session);
		const agentDir = getAgentDir();
		const mirror = getSharedMirror(agentDir);
		const destPath = resolveTuiScreenshotDest(this.session.settings, "mirror", runId);
		const timeoutMs = clampTimeout("browser", undefined) * 1000;
		const capture = await captureMirrorScreenshot({
			session: this.session,
			mirrorUrl: mirror.url,
			runId,
			destPath,
			timeoutMs,
			signal,
		});
		const summary = JSON.stringify(
			{
				session: session.id,
				runId,
				screenshot: { path: capture.path, mimeType: capture.mimeType, bytes: capture.bytes, source: "mirror" },
				url: capture.url,
			},
			null,
			2,
		);
		const content: Array<TextContent | ImageContent> = [{ type: "text", text: summary }, ...capture.displays];
		return toolResult<TuiDriveDetails>({
			action: params.action,
			session: session.id,
			runId,
			screenshotPath: capture.path,
		})
			.content(content)
			.done();
	}

	async #diff(params: TuiDriveParams): Promise<AgentToolResult<TuiDriveDetails>> {
		const session = this.#resolve(params);
		const runId = await resolveOmpRunId(session);
		const summary = await inspectLiveSession(getAgentDir(), runId);
		const internal = summary?.terminalSnapshotPath ? await readTerminalSnapshot(summary.terminalSnapshotPath) : null;
		if (!internal) {
			throw new ToolError(`Session ${runId} has no internal terminal snapshot to diff against.`);
		}
		await session.recorder.flush();
		const emulatorText = session.recorder.snapshot().text;
		const diff = diffRenderedText(internal.text, emulatorText);
		const capRow = (row: string) => (row.length > MAX_DIFF_ROW_CHARS ? `${row.slice(0, MAX_DIFF_ROW_CHARS)}…` : row);
		const payload = {
			session: session.id,
			runId,
			identical: diff.identical,
			scrollOffset: diff.scrollOffset,
			rowsCompared: diff.rowsCompared,
			matchedRows: diff.matchedRows,
			internal: {
				capturedAt: internal.capturedAt,
				ageMs: Math.max(0, Date.now() - Date.parse(internal.capturedAt)),
				cols: internal.cols,
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
		return this.#result(params, session, payload);
	}

	async #resize(params: TuiDriveParams): Promise<AgentToolResult<TuiDriveDetails>> {
		const session = this.#resolve(params);
		if (session.exit) throw new ToolError(`Drive session ${session.id} has exited.`);
		if (!params.cols || !params.rows) throw new ToolError('Action "resize" requires cols and rows.');
		session.pty.resize(params.cols, params.rows);
		session.recorder.resize(params.cols, params.rows);
		session.cols = params.cols;
		session.rows = params.rows;
		session.lastOutputAt = Date.now();
		await waitForIdle(session, this.#debounce(params), 2_000);
		return this.#result(params, session, await this.#screenPayload(session));
	}

	async #kill(params: TuiDriveParams): Promise<AgentToolResult<TuiDriveDetails>> {
		const session = this.#resolve(params);
		if (session.exit) {
			driveSessions.delete(session.id);
			session.recorder.dispose();
			const payload = { session: session.id, removed: true, exit: session.exit };
			return this.#result(params, session, payload);
		}
		try {
			session.pty.kill();
		} catch {
			// already exiting
		}
		await session.done;
		return this.#result(params, session, await this.#screenPayload(session));
	}

	#list(params: TuiDriveParams): AgentToolResult<TuiDriveDetails> {
		const sessions = [...driveSessions.values()].map(session => ({
			session: session.id,
			command: session.command,
			cwd: session.cwd,
			cols: session.cols,
			rows: session.rows,
			status: session.exit ? "exited" : "running",
			startedAt: new Date(session.startedAt).toISOString(),
			lastOutputAt: new Date(session.lastOutputAt).toISOString(),
			ompRunId: session.ompRunId,
		}));
		return toolResult<TuiDriveDetails>({ action: params.action })
			.text(JSON.stringify({ sessions }, null, 2))
			.done();
	}
}
