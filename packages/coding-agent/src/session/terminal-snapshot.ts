import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";

const XtermTerminal = xterm.Terminal;
const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 40;
const WRITE_FLUSH_DELAY_MS = 25;

export type TerminalColorMode = "palette" | "rgb";

export interface TerminalColor {
	mode: TerminalColorMode;
	/** Palette index 0-255 when `mode` is `palette`; packed 0xRRGGBB when `mode` is `rgb`. */
	value: number;
}

export interface TerminalCellSnapshot {
	text: string;
	width: number;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	blink: boolean;
	inverse: boolean;
	invisible: boolean;
	strikethrough: boolean;
	overline: boolean;
	fg?: TerminalColor;
	bg?: TerminalColor;
}

export interface TerminalLineSnapshot {
	row: number;
	text: string;
	isWrapped: boolean;
	cells: TerminalCellSnapshot[];
}

export interface TerminalSnapshot {
	capturedAt: string;
	cols: number;
	rows: number;
	cursorX: number;
	cursorY: number;
	cursorVisible: boolean;
	cursorStyle: "block" | "underline" | "bar";
	bufferType: "normal" | "alternate";
	viewportY: number;
	baseY: number;
	text: string;
	lines: TerminalLineSnapshot[];
}

export interface TerminalScrollbackCapture {
	/** Logical (wrap-joined) lines in the whole tape, trailing blank rows dropped. */
	totalLines: number;
	/** Index of the first logical line included in `text`. */
	startLine: number;
	/** Active buffer at capture time; "alternate" means the tape is what the app restores to. */
	bufferType: "normal" | "alternate";
	text: string;
}

export interface TerminalSnapshotRecorderOptions {
	path: string;
	cols?: number;
	rows?: number;
	now?: () => Date;
	/**
	 * Receives data the emulated terminal wants to send back to the host
	 * (e.g. DA1/DSR query replies). Providing it enables xterm stdin so those
	 * replies are generated; callers forward them into the PTY.
	 */
	onData?: (data: string) => void;
}

export interface TerminalSnapshotFromTextOptions {
	cols?: number;
	rows?: number;
	now?: () => Date;
}

export class TerminalSnapshotRecorder {
	readonly path: string;
	#terminal: XtermTerminalType;
	#writeQueue: string[] = [];
	#writeOffset = 0;
	#isWriting = false;
	#flushResolvers: Array<() => void> = [];
	#persistTimer: Timer | undefined;
	/**
	 * Serializes every snapshot write (scheduled and final) so two persists
	 * never write `path` concurrently, and a later-issued persist always lands
	 * after an earlier one — the final teardown snapshot cannot be overwritten
	 * by a stale scheduled persist that resolves out of order.
	 */
	#persistChain: Promise<void> = Promise.resolve();
	/** Set by {@link flushAndPersist}: stops arming new scheduled persists during teardown. */
	#closing = false;
	#cursorVisible = true;
	#now: () => Date;

	constructor(options: TerminalSnapshotRecorderOptions) {
		this.path = options.path;
		this.#now = options.now ?? (() => new Date());
		this.#terminal = new XtermTerminal({
			cols: clampColumns(options.cols ?? DEFAULT_COLUMNS),
			rows: clampRows(options.rows ?? DEFAULT_ROWS),
			disableStdin: !options.onData,
			allowProposedApi: true,
			scrollback: 10_000,
		});
		if (options.onData) this.#terminal.onData(options.onData);
	}

	resize(cols: number, rows: number): void {
		const nextCols = clampColumns(cols);
		const nextRows = clampRows(rows);
		if (nextCols === this.#terminal.cols && nextRows === this.#terminal.rows) return;
		this.#terminal.resize(nextCols, nextRows);
		this.#schedulePersist();
	}

	write(data: string): void {
		if (!data) return;
		this.#trackCursorVisibility(data);
		this.#writeQueue.push(data);
		this.#drainQueue();
	}

	flush(): Promise<void> {
		if (!this.#isWriting && this.#writeOffset >= this.#writeQueue.length) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#flushResolvers.push(resolve);
		return promise;
	}

	snapshot(): TerminalSnapshot {
		const buffer = this.#terminal.buffer.active;
		const start = buffer.viewportY;
		const end = Math.min(buffer.length, start + this.#terminal.rows);
		const lines: TerminalLineSnapshot[] = [];
		for (let row = start; row < end; row++) {
			const line = buffer.getLine(row);
			if (!line) continue;
			lines.push({
				row,
				text: line.translateToString(true),
				isWrapped: line.isWrapped,
				cells: snapshotCells(line, this.#terminal.cols),
			});
		}
		return {
			capturedAt: this.#now().toISOString(),
			cols: this.#terminal.cols,
			rows: this.#terminal.rows,
			cursorX: buffer.cursorX,
			cursorY: buffer.cursorY,
			cursorVisible: this.#cursorVisible,
			cursorStyle: this.#terminal.options.cursorStyle ?? "block",
			bufferType: buffer.type,
			viewportY: buffer.viewportY,
			baseY: buffer.baseY,
			text: lines
				.map(line => line.text)
				.join("\n")
				.trimEnd(),
			lines,
		};
	}

	/**
	 * The full normal-buffer tape (scrollback plus screen) as logical lines,
	 * wrapped rows joined back together. Scrollback only accumulates on the
	 * normal buffer, so an app on the alternate screen reports the tape it
	 * will restore to. Returns the last `limit` logical lines.
	 */
	scrollback(limit: number): TerminalScrollbackCapture {
		const buffer = this.#terminal.buffer.normal;
		const lines: string[] = [];
		for (let row = 0; row < buffer.length; row++) {
			const line = buffer.getLine(row);
			if (!line) continue;
			const text = line.translateToString(true);
			if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
			else lines.push(text);
		}
		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		const startLine = Math.max(0, lines.length - Math.max(1, limit));
		return {
			totalLines: lines.length,
			startLine,
			bufferType: this.#terminal.buffer.active.type,
			text: lines.slice(startLine).join("\n"),
		};
	}

	/**
	 * Write the current snapshot to {@link path}. The snapshot is captured
	 * synchronously at call time, then the write is appended to {@link #persistChain}
	 * so it runs strictly after any in-flight persist — the resolved promise waits
	 * for both this and every prior write. A recorder without a path (in-memory
	 * capture, e.g. the interactive bash overlay) is a no-op.
	 */
	persist(): Promise<void> {
		if (!this.path) return Promise.resolve();
		const payload = `${JSON.stringify(this.snapshot(), null, 2)}\n`;
		const done = this.#persistChain.then(() => Bun.write(this.path, payload)).then(() => {});
		// Keep the chain alive across a rejected write so later persists still run;
		// the returned `done` still surfaces this write's own rejection to callers.
		this.#persistChain = done.then(
			() => {},
			() => {},
		);
		return done;
	}

	/**
	 * Finalize the recorder for shutdown/restart/disposal: stop arming new
	 * scheduled persists, drain every queued xterm write, then persist the final
	 * state after all prior writes settle. Awaiting this before {@link dispose}
	 * guarantees queued terminal data reaches disk and no stale scheduled persist
	 * can overwrite the final snapshot at process exit.
	 */
	async flushAndPersist(): Promise<void> {
		this.#closing = true;
		if (this.#persistTimer) {
			clearTimeout(this.#persistTimer);
			this.#persistTimer = undefined;
		}
		await this.flush();
		await this.persist();
	}

	dispose(): void {
		if (this.#persistTimer) {
			clearTimeout(this.#persistTimer);
			this.#persistTimer = undefined;
		}
		this.#terminal.dispose();
	}

	/** Track DECTCEM (CSI ?25 h/l) so snapshots report the last recorded cursor visibility. */
	#trackCursorVisibility(data: string): void {
		const show = data.lastIndexOf("\x1b[?25h");
		const hide = data.lastIndexOf("\x1b[?25l");
		if (show === -1 && hide === -1) return;
		this.#cursorVisible = show > hide;
	}

	#drainQueue(): void {
		if (this.#isWriting) return;
		if (this.#writeOffset >= this.#writeQueue.length) {
			this.#resolveFlushWaiters();
			return;
		}
		this.#isWriting = true;
		const data = this.#writeQueue[this.#writeOffset]!;
		this.#terminal.write(data, () => {
			this.#isWriting = false;
			this.#writeOffset += 1;
			if (this.#writeOffset >= this.#writeQueue.length) {
				this.#writeQueue = [];
				this.#writeOffset = 0;
				this.#schedulePersist();
			}
			this.#drainQueue();
		});
	}

	#resolveFlushWaiters(): void {
		if (this.#isWriting || this.#writeOffset < this.#writeQueue.length) return;
		if (this.#flushResolvers.length === 0) return;
		const resolvers = this.#flushResolvers;
		this.#flushResolvers = [];
		for (const resolve of resolvers) resolve();
	}

	#schedulePersist(): void {
		// Never persist an in-memory recorder (no path), and stop arming new
		// timers once teardown has taken over the final persist.
		if (!this.path || this.#closing || this.#persistTimer) return;
		this.#persistTimer = setTimeout(() => {
			this.#persistTimer = undefined;
			void this.persist().catch(error => {
				logger.warn("Failed to persist terminal snapshot", { error: String(error), path: this.path });
			});
		}, WRITE_FLUSH_DELAY_MS);
		this.#persistTimer.unref?.();
	}
}

export async function readTerminalSnapshot(snapshotPath: string): Promise<TerminalSnapshot | null> {
	try {
		return JSON.parse(await Bun.file(snapshotPath).text()) as TerminalSnapshot;
	} catch (error) {
		if (isEnoentError(error)) return null;
		logger.warn("Failed to read terminal snapshot", { error: String(error), path: snapshotPath });
		return null;
	}
}

export async function createTerminalSnapshotRecorder(
	options: TerminalSnapshotRecorderOptions,
): Promise<TerminalSnapshotRecorder> {
	await fs.mkdir(path.dirname(options.path), { recursive: true });
	return new TerminalSnapshotRecorder(options);
}

export async function createTerminalSnapshotFromText(
	text: string,
	options: TerminalSnapshotFromTextOptions = {},
): Promise<TerminalSnapshot> {
	const recorder = new TerminalSnapshotRecorder({
		path: "",
		cols: options.cols,
		rows: options.rows,
		now: options.now,
	});
	try {
		recorder.write(text);
		await recorder.flush();
		return recorder.snapshot();
	} finally {
		recorder.dispose();
	}
}

interface XtermCell {
	getChars(): string;
	getWidth(): number;
	isBold(): number;
	isDim(): number;
	isItalic(): number;
	isUnderline(): number;
	isBlink(): number;
	isInverse(): number;
	isInvisible(): number;
	isStrikethrough(): number;
	isOverline(): number;
	isFgDefault(): boolean;
	isBgDefault(): boolean;
	isFgRGB(): boolean;
	isBgRGB(): boolean;
	getFgColor(): number;
	getBgColor(): number;
}

function snapshotCells(
	line: { getCell(index: number, cell?: unknown): unknown },
	cols: number,
): TerminalCellSnapshot[] {
	const cells: TerminalCellSnapshot[] = [];
	for (let column = 0; column < cols; column++) {
		const cell = line.getCell(column) as XtermCell | undefined;
		if (!cell) continue;
		const text = cell.getChars();
		if (!text) continue;
		cells.push({
			text,
			width: cell.getWidth(),
			bold: cell.isBold() !== 0,
			dim: cell.isDim() !== 0,
			italic: cell.isItalic() !== 0,
			underline: cell.isUnderline() !== 0,
			blink: cell.isBlink() !== 0,
			inverse: cell.isInverse() !== 0,
			invisible: cell.isInvisible() !== 0,
			strikethrough: cell.isStrikethrough() !== 0,
			overline: cell.isOverline() !== 0,
			fg: readColor(cell, "fg"),
			bg: readColor(cell, "bg"),
		});
	}
	return cells;
}

function readColor(cell: XtermCell, channel: "fg" | "bg"): TerminalColor | undefined {
	if (channel === "fg") {
		if (cell.isFgDefault()) return undefined;
		return { mode: cell.isFgRGB() ? "rgb" : "palette", value: cell.getFgColor() };
	}
	if (cell.isBgDefault()) return undefined;
	return { mode: cell.isBgRGB() ? "rgb" : "palette", value: cell.getBgColor() };
}

const ANSI_16: readonly number[] = [
	0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0, 0x808080, 0xff0000, 0x00ff00,
	0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
];
const ANSI_CUBE_LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255];

/** Resolve an ANSI 256-color palette index to a packed 0xRRGGBB value. */
export function ansi256ToRgb(index: number): number {
	if (index < 0) return 0;
	if (index < 16) return ANSI_16[index] ?? 0;
	if (index < 232) {
		const value = index - 16;
		const r = ANSI_CUBE_LEVELS[Math.floor(value / 36) % 6]!;
		const g = ANSI_CUBE_LEVELS[Math.floor(value / 6) % 6]!;
		const b = ANSI_CUBE_LEVELS[value % 6]!;
		return (r << 16) | (g << 8) | b;
	}
	if (index < 256) {
		const gray = 8 + (index - 232) * 10;
		return (gray << 16) | (gray << 8) | gray;
	}
	return 0;
}

/** Render a snapshot color as a CSS hex string, resolving palette indices to RGB. */
export function terminalColorToCss(color: TerminalColor): string {
	const rgb = color.mode === "rgb" ? color.value & 0xffffff : ansi256ToRgb(color.value);
	return `#${rgb.toString(16).padStart(6, "0")}`;
}

function clampColumns(cols: number): number {
	return Number.isFinite(cols) ? Math.max(1, Math.floor(cols)) : DEFAULT_COLUMNS;
}

function clampRows(rows: number): number {
	return Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : DEFAULT_ROWS;
}

function isEnoentError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
