import type { FileSink } from "bun";
import { createTerminalSnapshotFromText } from "./terminal-snapshot";

export type AsciicastEventCode = "o" | "i" | "r" | "m";

export interface AsciicastHeader {
	version: 2;
	width: number;
	height: number;
	timestamp?: number;
	command?: string;
	title?: string;
	env?: Record<string, string>;
}

export interface AsciicastEvent {
	time: number;
	code: AsciicastEventCode;
	data: string;
}

export interface Asciicast {
	header: AsciicastHeader;
	events: AsciicastEvent[];
}

export interface AsciicastSummary {
	width: number;
	height: number;
	durationSeconds: number;
	eventCount: number;
	outputBytes: number;
}

export interface AsciicastFrame {
	atSeconds: number;
	text: string;
}

export interface AsciicastRecorderOptions {
	path: string;
	cols: number;
	rows: number;
	command?: string;
	title?: string;
	now?: () => number;
}

/** Streams asciicast v2 events to a .cast file as terminal output arrives. */
export class AsciicastRecorder {
	readonly path: string;
	#sink: FileSink;
	#now: () => number;
	#startMs: number;
	#eventCount = 0;
	#lastTime = 0;
	#closed = false;

	constructor(options: AsciicastRecorderOptions) {
		this.path = options.path;
		this.#now = options.now ?? (() => Date.now());
		this.#startMs = this.#now();
		const header: AsciicastHeader = {
			version: 2,
			width: options.cols,
			height: options.rows,
			timestamp: Math.floor(this.#startMs / 1000),
			env: { TERM: "xterm-256color" },
		};
		if (options.command !== undefined) header.command = options.command;
		if (options.title !== undefined) header.title = options.title;
		this.#sink = Bun.file(options.path).writer();
		this.#sink.write(`${JSON.stringify(header)}\n`);
	}

	write(data: string, code: "o" | "i" = "o"): void {
		this.#append(code, data);
	}

	resize(cols: number, rows: number): void {
		this.#append("r", `${cols}x${rows}`);
	}

	get eventCount(): number {
		return this.#eventCount;
	}

	get durationSeconds(): number {
		return this.#lastTime;
	}

	async flush(): Promise<void> {
		await this.#sink.flush();
	}

	async finalize(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#sink.end();
	}

	dispose(): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#sink.end();
		} catch {
			// Best-effort synchronous close; a half-written cast still parses.
		}
	}

	#append(code: AsciicastEventCode, data: string): void {
		const elapsed = this.#elapsed();
		this.#lastTime = elapsed;
		this.#eventCount += 1;
		this.#sink.write(`${JSON.stringify([elapsed, code, data])}\n`);
	}

	#elapsed(): number {
		const elapsed = Math.round(((this.#now() - this.#startMs) / 1000) * 1e6) / 1e6;
		return Math.max(0, elapsed);
	}
}

/** Parse a .cast file's text. Tolerates blank/trailing lines; throws on a missing header or version !== 2. */
export function parseAsciicast(text: string): Asciicast {
	const lines = text.split("\n");
	let index = 0;
	while (index < lines.length && lines[index]!.trim() === "") index += 1;
	if (index >= lines.length) throw new Error("asciicast: missing header");
	const header = JSON.parse(lines[index]!) as AsciicastHeader;
	index += 1;
	if (header.version !== 2) throw new Error(`asciicast: unsupported version ${header.version}`);
	const events: AsciicastEvent[] = [];
	for (; index < lines.length; index += 1) {
		const line = lines[index]!;
		if (line.trim() === "") continue;
		const [time, code, data] = JSON.parse(line) as [number, AsciicastEventCode, string];
		events.push({ time, code, data });
	}
	return { header, events };
}

export function summarizeAsciicast(cast: Asciicast): AsciicastSummary {
	let outputBytes = 0;
	for (const event of cast.events) {
		if (event.code === "o") outputBytes += Buffer.byteLength(event.data, "utf8");
	}
	return {
		width: cast.header.width,
		height: cast.header.height,
		durationSeconds: cast.events.at(-1)?.time ?? 0,
		eventCount: cast.events.length,
		outputBytes,
	};
}

/** Reconstruct the visible grid at `atSeconds` by feeding every "o" event with time <= atSeconds through the emulator. */
export async function renderAsciicastFrame(
	cast: Asciicast,
	atSeconds: number,
	options?: { cols?: number; rows?: number },
): Promise<string> {
	let buffer = "";
	for (const event of cast.events) {
		if (event.time > atSeconds) break;
		if (event.code === "o") buffer += event.data;
	}
	const cols = options?.cols ?? cast.header.width;
	const rows = options?.rows ?? cast.header.height;
	const snapshot = await createTerminalSnapshotFromText(buffer, { cols, rows });
	return snapshot.text;
}

/** Sample `count` frames evenly across the duration at times duration*(i+1)/count for i in 0..count-1. */
export async function sampleAsciicastFrames(
	cast: Asciicast,
	count: number,
	options?: { cols?: number; rows?: number },
): Promise<AsciicastFrame[]> {
	const total = count < 1 ? 1 : count;
	const duration = summarizeAsciicast(cast).durationSeconds;
	const frames: AsciicastFrame[] = [];
	for (let i = 0; i < total; i += 1) {
		const atSeconds = (duration * (i + 1)) / total;
		const text = await renderAsciicastFrame(cast, atSeconds, options);
		frames.push({ atSeconds, text });
	}
	return frames;
}
