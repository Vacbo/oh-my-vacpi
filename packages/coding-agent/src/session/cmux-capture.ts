import { $which } from "@oh-my-pi/pi-utils";

/**
 * Emulator-side terminal capture for sessions hosted in cmux.
 *
 * The internal snapshot (terminal-snapshot.ts) is what the renderer believes the
 * screen looks like: the session's output replayed through xterm-headless. cmux
 * (libghostty) can report what its terminal actually rendered via
 * `cmux read-screen --surface <id>`. Diffing the two row by row localizes a
 * rendering bug to one side: a mismatched row was either emitted wrong by the
 * TUI or interpreted differently by the emulator.
 *
 * Text grids cannot show inline images (Kitty graphics, iTerm2, Sixel), glyph
 * substitution, or colors; pixel captures (native-terminal-capture.ts) cover
 * those. The surface id is recorded into the live-session registry at startup
 * from CMUX_SURFACE_ID, so any process can later read another session's screen.
 */

export interface CmuxScreenRequest {
	surfaceId: string;
	/** Return only the last N lines, including scrollback. Omit for the visible viewport. */
	lines?: number;
}

export interface CmuxScreen {
	source: "cmux";
	surfaceId: string;
	text: string;
	command: string[];
}

export type CmuxCaptureFailureReason = "no-cmux" | "read-failed";

export type CmuxCaptureOutcome =
	| { ok: true; result: CmuxScreen }
	| { ok: false; reason: CmuxCaptureFailureReason; message: string };

export interface CmuxCaptureDeps {
	env: Record<string, string | undefined>;
	which(bin: string): Promise<boolean> | boolean;
	exec(command: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export function defaultCmuxCaptureDeps(): CmuxCaptureDeps {
	return {
		env: { ...process.env },
		which: bin => $which(bin) !== null,
		async exec(command) {
			const proc = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
				new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
			]);
			const exitCode = await proc.exited;
			return { exitCode, stdout, stderr };
		},
	};
}

/**
 * Resolve the cmux surface hosting a session. The id recorded at registration
 * wins; the current process can still fall back to its own environment, which
 * covers runs registered before the field existed and process-only sessions.
 */
export function cmuxSurfaceIdFor(
	session: { pid: number; cmuxSurfaceId?: string },
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	if (session.cmuxSurfaceId) return session.cmuxSurfaceId;
	return session.pid === process.pid ? env.CMUX_SURFACE_ID : undefined;
}

/** Read the text grid cmux rendered for a surface via `cmux read-screen`. */
export async function readCmuxScreen(
	request: CmuxScreenRequest,
	deps: CmuxCaptureDeps = defaultCmuxCaptureDeps(),
): Promise<CmuxCaptureOutcome> {
	const cmuxBin = deps.env.CMUX_OMP_CMUX_BIN || "cmux";
	if (!(await deps.which(cmuxBin))) {
		return { ok: false, reason: "no-cmux", message: `cmux binary ("${cmuxBin}") not found on PATH.` };
	}
	const command = [cmuxBin, "read-screen", "--surface", request.surfaceId];
	if (request.lines !== undefined) command.push("--lines", String(request.lines));
	const exec = await deps.exec(command);
	if (exec.exitCode !== 0) {
		const detail = exec.stderr.trim() || exec.stdout.trim() || `exit code ${exec.exitCode}`;
		return { ok: false, reason: "read-failed", message: `${command.join(" ")} failed: ${detail}` };
	}
	return {
		ok: true,
		result: { source: "cmux", surfaceId: request.surfaceId, text: exec.stdout.replace(/\n$/, ""), command },
	};
}

export interface RenderDiffRow {
	/** 0-based row in the compared grids. */
	row: number;
	/** What the internal snapshot believes is on this row. */
	internal: string;
	/** What the terminal emulator actually rendered. */
	emulator: string;
}

export interface RenderDiff {
	/** True only when the grids match with no scroll between the captures. */
	identical: boolean;
	/**
	 * Rows the emulator content moved up relative to the snapshot (negative:
	 * down). The two captures are not simultaneous, so a busy session often
	 * scrolls between them; a non-zero offset with few mismatches means the
	 * screens agree and only the timing differed.
	 */
	scrollOffset: number;
	rowsCompared: number;
	matchedRows: number;
	internalRows: number;
	emulatorRows: number;
	mismatches: RenderDiffRow[];
}

export interface RenderDiffOptions {
	/** How far to search for a vertical scroll between the two captures. */
	maxScrollOffset?: number;
}

const DEFAULT_MAX_SCROLL_OFFSET = 24;

/** Trailing whitespace per row and trailing blank rows are padding, not content. */
function normalizeGrid(text: string): string[] {
	const rows = text.split("\n").map(row => row.trimEnd());
	while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
	return rows;
}

/** Count non-blank rows that agree when the snapshot is shifted by `offset`. */
function nonBlankMatchesAtOffset(internal: string[], emulator: string[], offset: number): number {
	let matched = 0;
	for (let row = 0; row < emulator.length; row++) {
		const ours = internal[row + offset];
		if (ours !== undefined && ours !== "" && ours === emulator[row]) matched++;
	}
	return matched;
}

/** Find the shift that aligns the most content; ties keep the smallest offset. */
function bestScrollOffset(internal: string[], emulator: string[], maxOffset: number): number {
	let best = 0;
	let bestScore = nonBlankMatchesAtOffset(internal, emulator, 0);
	for (let distance = 1; distance <= maxOffset; distance++) {
		for (const offset of [distance, -distance]) {
			const score = nonBlankMatchesAtOffset(internal, emulator, offset);
			if (score > bestScore) {
				best = offset;
				bestScore = score;
			}
		}
	}
	return best;
}

/**
 * Compare the internal snapshot text against the emulator's text, row by row.
 * A vertical scroll between the two captures is detected first so it reads as
 * one `scrollOffset` instead of a wall of false mismatches. When aligned,
 * rows missing on one side compare against "" so a size skew shows up as
 * mismatches instead of being silently clipped; when scrolled, only the
 * overlapping region is compared. Mismatch rows are emulator (on-screen) rows.
 */
export function diffRenderedText(
	internalText: string,
	emulatorText: string,
	options: RenderDiffOptions = {},
): RenderDiff {
	const internal = normalizeGrid(internalText);
	const emulator = normalizeGrid(emulatorText);
	const maxOffset = Math.max(0, options.maxScrollOffset ?? DEFAULT_MAX_SCROLL_OFFSET);
	const scrollOffset = bestScrollOffset(internal, emulator, maxOffset);
	const mismatches: RenderDiffRow[] = [];
	let rowsCompared = 0;
	if (scrollOffset === 0) {
		rowsCompared = Math.max(internal.length, emulator.length);
		for (let row = 0; row < rowsCompared; row++) {
			const ours = internal[row] ?? "";
			const theirs = emulator[row] ?? "";
			if (ours !== theirs) mismatches.push({ row, internal: ours, emulator: theirs });
		}
	} else {
		for (let row = 0; row < emulator.length; row++) {
			const ours = internal[row + scrollOffset];
			if (ours === undefined) continue;
			rowsCompared++;
			if (ours !== emulator[row]) mismatches.push({ row, internal: ours, emulator: emulator[row]! });
		}
	}
	return {
		identical: scrollOffset === 0 && mismatches.length === 0,
		scrollOffset,
		rowsCompared,
		matchedRows: rowsCompared - mismatches.length,
		internalRows: internal.length,
		emulatorRows: emulator.length,
		mismatches,
	};
}
