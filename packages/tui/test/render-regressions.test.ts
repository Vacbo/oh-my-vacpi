import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// Terminal-state regressions that are independent of how finality is decided.
//
// The pre-v18 version of this suite also encoded the native-scrollback commit
// ledger (window/commit indices, live-region boundaries, deferred mutations,
// scrollback rebuild). That engine is gone: history now arrives only as an
// explicit `HistoryBatch` from a `TerminalFrameProvider`, and a host that just
// composes children paints the bottom `height` rows as a viewport and never
// touches history (`tui.ts` `#renderChildrenFrame`). Those assertions moved to
// `history-frame-plan.test.ts` and `resize-anchor-recovery.test.ts`.
//
// What survives here are contracts the paint transaction still owns, none of
// which depend on the commit model:
//   * per-row SGR resets confine a component's unreset styling to its own row
//     (BCE terminals erase with the current background);
//   * autowrap stays disabled across a paint so an exact-width row never
//     latches pending-wrap into a staircase/phantom row;
//   * a grapheme cluster the terminal may measure differently is contained to
//     its row, and differential row targeting stays exact afterwards;
//   * every cursor sequence is emitted inside the synchronized-output bracket.

/** Passes lines through unsliced so the renderer's own width fitting decides row content. */
class RawLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(): string[] {
		return [...this.#lines];
	}
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_v, i) => `${prefix}${i}`);
}

// Frames run on a virtual clock. A reentrant scheduler (one that calls its
// callback before returning a timer) must NOT be used here: tui.ts assigns the
// returned timer to `#renderTimer` AFTER `#runScheduledRender` has already
// cleared it, so `#renderTimer` stays truthy and every later ordinary
// `requestRender()` early-returns — silently making post-mutation assertions
// vacuous.
const scheduler = new VirtualRenderScheduler();

async function settle(term: VirtualTerminal): Promise<void> {
	await scheduler.settle(term);
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

describe("SGR containment (BCE)", () => {
	// Components leak unreset SGR (markdown renderers, raw tool output). On BCE
	// terminals (kitty, xterm, VTE, xterm.js, ...) `\x1b[K`/`\x1b[2K`/`\x1b[2J`
	// erase cells using the CURRENT background, so background state that leaks
	// past a row boundary paints whole phantom-colored rows — the "random
	// colored blank rows" bug class. Per-row terminators must confine a
	// component's unreset style to its own row on every emit path.
	const UNRESET_BG_ROW = "\x1b[41mRED-BG-NO-RESET";
	const UNRESET_FG_UNDERLINE_ROW = "\x1b[32;4mGREEN-UNDER-NO-RESET";

	function backgroundRows(term: VirtualTerminal, height: number): number[] {
		const styled: number[] = [];
		for (let row = 0; row < height; row++) {
			if (term.getViewportRowBackgroundColumns(row).length > 0) styled.push(row);
		}
		return styled;
	}

	function foregroundRows(term: VirtualTerminal, height: number): number[] {
		const styled: number[] = [];
		for (let row = 0; row < height; row++) {
			if (term.getViewportRowForegroundColumns(row).length > 0) styled.push(row);
		}
		return styled;
	}

	function underlineRows(term: VirtualTerminal, height: number): number[] {
		const styled: number[] = [];
		for (let row = 0; row < height; row++) {
			if (term.getViewportRowUnderlineColumns(row).length > 0) styled.push(row);
		}
		return styled;
	}

	it("confines an unreset background to its own row across initial, diff, and shrink paints", async () => {
		const height = 6;
		const term = new VirtualTerminal(20, height);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const component = new RawLinesComponent(["plain-0", UNRESET_BG_ROW, "plain-2"]);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);
			// Initial paint: only the styled row carries background cells.
			expect(backgroundRows(term, height)).toEqual([1]);

			// Diff path: rewriting the row below erases to end-of-line; with leaked
			// background, BCE would paint that row red.
			component.setLines(["plain-0", UNRESET_BG_ROW, "EDITED-2"]);
			tui.requestRender();
			await settle(term);
			expect(backgroundRows(term, height)).toEqual([1]);
			expect(visible(term)[2]).toBe("EDITED-2");

			// Shrink path: the dropped row must come back as a default-background
			// blank, not a red bar.
			component.setLines(["plain-0", UNRESET_BG_ROW]);
			tui.requestRender();
			await settle(term);
			expect(backgroundRows(term, height)).toEqual([1]);
			expect(visible(term)[2]).toBe("");
		} finally {
			tui.stop();
		}
	});

	it("confines unreset foreground and underline to their own row", async () => {
		const height = 6;
		const term = new VirtualTerminal(24, height);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const component = new RawLinesComponent(["plain-0", UNRESET_FG_UNDERLINE_ROW, "plain-2"]);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);
			expect(foregroundRows(term, height)).toEqual([1]);
			expect(underlineRows(term, height)).toEqual([1]);

			// Rewriting the next row erases to end-of-line; leaked SGR would make the
			// edited row green/underlined despite containing plain text.
			component.setLines(["plain-0", UNRESET_FG_UNDERLINE_ROW, "EDITED-2"]);
			tui.requestRender();
			await settle(term);
			expect(foregroundRows(term, height)).toEqual([1]);
			expect(underlineRows(term, height)).toEqual([1]);
			expect(term.getViewportRowForegroundColumns(2)).toEqual([]);
			expect(term.getViewportRowUnderlineColumns(2)).toEqual([]);

			component.setLines(["plain-0", UNRESET_FG_UNDERLINE_ROW]);
			tui.requestRender();
			await settle(term);
			expect(foregroundRows(term, height)).toEqual([1]);
			expect(underlineRows(term, height)).toEqual([1]);
			expect(term.getViewportRowForegroundColumns(2)).toEqual([]);
			expect(term.getViewportRowUnderlineColumns(2)).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("confines an unreset background during full viewport repaints", async () => {
		const height = 4;
		const term = new VirtualTerminal(20, height);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		// Taller than the viewport: the children path paints the bottom `height`
		// rows, so the styled row sits offscreen and no visible row may inherit it.
		const component = new RawLinesComponent(["plain-0", UNRESET_BG_ROW, ...rows("tail-", 4)]);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);

			tui.requestRender(true);
			await settle(term);

			expect(backgroundRows(term, height)).toEqual([]);
			expect(term.getViewportRowBackgroundColumns(0)).toEqual([]);
		} finally {
			tui.stop();
		}
	});
});

describe("paint volume stays bounded by the viewport", () => {
	// A resumed session can compose thousands of rows (issue #2115: a large CJK
	// transcript on a Windows console host). The paint must stay proportional to
	// the viewport, not to the composed frame: the pre-v18 engine bounded a
	// history replay explicitly, while v18's children path never touches history
	// and paints only the bottom `height` rows. Either way a first paint must not
	// push a multi-megabyte payload at the terminal.
	it("keeps a first paint of a huge frame small and anchored on the tail", async () => {
		const height = 24;
		const term = new VirtualTerminal(80, height);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const lines = Array.from({ length: 9000 }, (_v, i) => `第${i.toString().padStart(5, "0")}行：${"界".repeat(80)}`);
		tui.addChild(new RawLinesComponent(lines));

		try {
			tui.start();
			await settle(term);

			expect(Buffer.byteLength(writes.join(""), "utf8")).toBeLessThan(128 * 1024);
			expect(visible(term).at(-1)).toContain("第08999行");
		} finally {
			vi.restoreAllMocks();
			tui.stop();
		}
	});
});

describe("pending-wrap / DECAWM at exact-width rows", () => {
	// A row whose visible width EXACTLY equals the terminal width writes its last
	// cell, latching "pending wrap" on autowrap terminals — a following cursor
	// move can then wrap and produce staircase trails / phantom rows. The paint
	// disables autowrap (\x1b[?7l) and restores it (\x1b[?7h) only at PAINT_END,
	// after emitting explicit CRLFs, so an exact-width row never latches it.
	const exactAscii = "0123456789";
	const exactWide = "AAAA界界界"; // 4 + 2 + 2 + 2 = 10 cells

	it("keeps exact-width rows on one terminal row without staircase", async () => {
		const width = 10;
		const height = 6;
		const term = new VirtualTerminal(width, height);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const component = new RawLinesComponent(["top", exactAscii, exactWide, "bot"]);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);

			// One terminal row per logical line — neither exact-width row wrapped.
			expect(visible(term)).toEqual(["top", exactAscii, exactWide, "bot", "", ""]);

			// Diff-edit the row below the exact-width wide row: if pending-wrap had
			// latched, the relative cursor move would land a row off.
			component.setLines(["top", exactAscii, exactWide, "EDIT"]);
			tui.requestRender();
			await settle(term);
			expect(visible(term)).toEqual(["top", exactAscii, exactWide, "EDIT", "", ""]);
		} finally {
			tui.stop();
		}
	});

	it("keeps row accounting exact when exact-width rows scroll out of the viewport", async () => {
		const width = 10;
		const height = 4;
		const term = new VirtualTerminal(width, height);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const component = new RawLinesComponent(["top", exactAscii, exactWide, "bot"]);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);
			expect(visible(term)).toEqual(["top", exactAscii, exactWide, "bot"]);

			// Grow past the viewport: the bottom `height` rows stay one row each, so
			// a latched wrap cannot insert a phantom row into the visible tail.
			component.setLines(["top", exactAscii, exactWide, "bot", ...rows("a-", 3)]);
			tui.requestRender();
			await settle(term);
			expect(visible(term)).toEqual([exactWide, "bot", ...rows("a-", 3)].slice(-height));
		} finally {
			tui.stop();
		}
	});
});

describe("grapheme-cluster row containment", () => {
	// A ZWJ family sequence is one cluster the renderer measures itself. Content
	// writes are wrapped in DECAWM-off, so even a terminal that measures the
	// cluster wider than the renderer must contain the overrun to the row rather
	// than wrapping into a phantom row — and differential row targeting after
	// such a row must stay exact.
	const ZWJ_FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
	const zwjRow = `${"B".repeat(18)}${ZWJ_FAMILY}`;

	it("keeps a ZWJ boundary row on one terminal row", async () => {
		const width = 20;
		const height = 6;
		const term = new VirtualTerminal(width, height);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const component = new RawLinesComponent(["header", zwjRow, "tail"]);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);

			const viewport = visible(term);
			expect(viewport[0]).toBe("header");
			expect(viewport[1]?.startsWith("B".repeat(18))).toBe(true);
			expect(viewport[2]).toBe("tail");
			expect(viewport[3]).toBe("");
		} finally {
			tui.stop();
		}
	});

	it("keeps differential row targeting exact after rendering a ZWJ boundary row", async () => {
		const width = 20;
		const height = 8;
		const term = new VirtualTerminal(width, height);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const component = new RawLinesComponent(["row-0", zwjRow, "row-2", "row-3", "row-4"]);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);

			// Diff-edit the row below the cluster row. If measuring it had desynced
			// hardware-cursor row tracking, this write would land on the wrong row.
			component.setLines(["row-0", zwjRow, "EDITED", "row-3", "row-4"]);
			tui.requestRender();
			await settle(term);

			const viewport = visible(term);
			expect(viewport[0]).toBe("row-0");
			expect(viewport[2]).toBe("EDITED");
			expect(viewport[3]).toBe("row-3");
			expect(viewport[4]).toBe("row-4");
			// The neighbor above the edit was not rewritten or moved.
			expect(viewport[1]?.startsWith("B".repeat(18))).toBe(true);
		} finally {
			tui.stop();
		}
	});
});

describe("cursor escape sequences stay inside synchronized output blocks", () => {
	// Cursor placement sequences that must not leak outside \x1b[?2026h…\x1b[?2026l
	const CURSOR_SEQ = /\x1b\[(?:\?25[hl]|(?:\d+(?:;\d+)*)?[A-H])/g;
	const BSU = "\x1b[?2026h";
	const ESU = "\x1b[?2026l";
	const HIDE_CURSOR = "\x1b[?25l";
	const DISABLE_AUTOWRAP = "\x1b[?7l";
	const ENABLE_AUTOWRAP = "\x1b[?7h";

	// Force DEC 2026 synchronized output on regardless of the host terminal so
	// these bracketing assertions stay deterministic. In CI an unknown TERM
	// disables sync output by default, which would emit no BSU/ESU pairs.
	const SYNC_ENV: Record<string, string | undefined> = {
		PI_FORCE_SYNC_OUTPUT: "1",
		PI_NO_SYNC_OUTPUT: undefined,
		PI_TUI_SYNC_OUTPUT: undefined,
	};
	const savedSyncEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key in SYNC_ENV) {
			savedSyncEnv[key] = Bun.env[key];
			const value = SYNC_ENV[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	});

	afterEach(() => {
		for (const key in savedSyncEnv) {
			const value = savedSyncEnv[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		vi.restoreAllMocks();
	});

	function getWrites(term: VirtualTerminal): string[] {
		const writes: string[] = [];
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
		});
		return writes;
	}

	/**
	 * Assert that every cursor escape sequence in every write appears strictly
	 * between a matched BSU/ESU pair, is the leading hideCursor that
	 * intentionally precedes BSU, or is the sole payload of a standalone
	 * hideCursor write (from a no-change/no-cursor path).
	 */
	function assertCursorSequencesInsideSyncBlocks(writes: string[]): void {
		for (const write of writes) {
			if (write === HIDE_CURSOR) continue;
			let depth = 0;
			let idx = 0;
			while (idx < write.length) {
				CURSOR_SEQ.lastIndex = idx;
				const match = CURSOR_SEQ.exec(write);
				if (!match) break;

				const matchIdx = match.index;
				let scanIdx = idx;
				while (scanIdx < matchIdx) {
					if (write.startsWith(BSU, scanIdx)) {
						depth++;
						scanIdx += BSU.length;
					} else if (write.startsWith(ESU, scanIdx)) {
						depth--;
						scanIdx += ESU.length;
					} else {
						scanIdx++;
					}
				}

				if (match[0] === HIDE_CURSOR && write.startsWith(HIDE_CURSOR + BSU) && matchIdx === 0) {
					idx = matchIdx + match[0].length;
					continue;
				}
				expect(depth).toBeGreaterThan(0);

				idx = matchIdx + match[0].length;
			}
		}
	}

	it("brackets every cursor sequence on the first full paint", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const writes = getWrites(term);
		tui.addChild(new RawLinesComponent(["hello", "world"]));

		try {
			tui.start();
			await settle(term);
			assertCursorSequencesInsideSyncBlocks(writes);
		} finally {
			tui.stop();
		}
	});

	it("brackets every cursor sequence on a differential paint", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const component = new RawLinesComponent(["AAA", "BBB", "CCC"]);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);

			const writes = getWrites(term);
			component.setLines(["AAA", "XXX", "CCC"]);
			tui.requestRender();
			await settle(term);
			assertCursorSequencesInsideSyncBlocks(writes);
		} finally {
			tui.stop();
		}
	});

	it("brackets every cursor sequence when rows are removed", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const component = new RawLinesComponent(["A", "B", "C", "D"]);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);

			const writes = getWrites(term);
			component.setLines(["A", "B"]);
			tui.requestRender();
			await settle(term);
			assertCursorSequencesInsideSyncBlocks(writes);
		} finally {
			tui.stop();
		}
	});

	it("brackets every cursor sequence across repeated no-op renders", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		tui.addChild(new RawLinesComponent(["hello", "world", "stable"]));

		try {
			tui.start();
			await settle(term);

			const writes = getWrites(term);
			for (let i = 0; i < 4; i++) {
				tui.requestRender();
				await settle(term);
			}
			assertCursorSequencesInsideSyncBlocks(writes);
		} finally {
			tui.stop();
		}
	});

	it("disables terminal autowrap for the whole paint payload", async () => {
		const term = new VirtualTerminal(12, 6);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const component = new RawLinesComponent(["ABCDEFGHIJKL", "tail"]);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);

			const writes = getWrites(term);
			component.setLines(["XXXXEFGHIJKL", "tail"]);
			tui.requestRender();
			await settle(term);

			const paintWrites = writes.filter(write => write.includes(BSU));
			expect(paintWrites.length).toBeGreaterThan(0);
			for (const write of paintWrites) {
				const begin = write.indexOf(BSU);
				expect(write.startsWith(HIDE_CURSOR)).toBe(true);
				expect(begin).toBe(HIDE_CURSOR.length);
				const disable = write.indexOf(DISABLE_AUTOWRAP, begin + BSU.length);
				const enable = write.lastIndexOf(ENABLE_AUTOWRAP);
				const end = write.lastIndexOf(ESU);
				expect(disable).toBe(begin + BSU.length);
				expect(enable).toBeGreaterThan(disable);
				expect(end).toBeGreaterThan(enable);
			}
		} finally {
			tui.stop();
		}
	});
});
