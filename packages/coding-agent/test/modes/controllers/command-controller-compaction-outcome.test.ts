import { beforeAll, describe, expect, it, vi } from "bun:test";
import { NothingToCompactError } from "@oh-my-pi/pi-agent-core/compaction";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

beforeAll(async () => {
	await initTheme(false);
});

function createContext(compactError: Error) {
	const showWarning = vi.fn();
	const showError = vi.fn();
	const context = {
		loadingAnimation: undefined,
		statusContainer: { clear: vi.fn(), addChild: vi.fn() },
		chatContainer: { addChild: vi.fn() },
		ui: { requestRender: vi.fn() },
		editor: { onEscape: undefined as (() => void) | undefined },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		rebuildChatFromMessages: vi.fn(),
		flushCompactionQueue: vi.fn(async () => {}),
		showWarning,
		showError,
		session: {
			compact: vi.fn(async () => {
				throw compactError;
			}),
			abortCompaction: vi.fn(),
		},
	};
	return { context, showWarning, showError };
}

describe("CommandController.executeCompaction", () => {
	it("treats NothingToCompactError as a benign no-op, not a failure", async () => {
		// Plan approval's "compact context" branch dispatches execution only when
		// the outcome is not "cancelled"; an already-compacted session (e.g. idle
		// compaction won the race) must surface a notice, not a failure.
		const { context, showWarning, showError } = createContext(
			new NothingToCompactError("Nothing to compact (session too small)"),
		);
		const controller = new CommandController(context as unknown as InteractiveModeContext);

		const outcome = await controller.executeCompaction();

		expect(outcome).toBe("ok");
		expect(showWarning).toHaveBeenCalledWith("Nothing to compact (session too small)");
		expect(showError).not.toHaveBeenCalled();
	});

	it("still reports unexpected compaction errors as failed", async () => {
		const { context, showWarning, showError } = createContext(new Error("summarizer exploded"));
		const controller = new CommandController(context as unknown as InteractiveModeContext);

		const outcome = await controller.executeCompaction();

		expect(outcome).toBe("failed");
		expect(showError).toHaveBeenCalledWith("Compaction failed: summarizer exploded");
		expect(showWarning).not.toHaveBeenCalled();
	});
});
