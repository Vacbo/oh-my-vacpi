import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 200,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 210,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createIdleContext() {
	const runIdleCompaction = vi.fn();
	const context = {
		isInitialized: true,
		loadingAnimation: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		planReviewActive: false,
		pendingTools: new Map<string, unknown>(),
		flushPendingModelSwitch: async () => {},
		ui: { requestRender: vi.fn() },
		chatContainer: { removeChild: vi.fn() },
		statusContainer: { clear: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		editor: { getText: () => "" },
		sessionManager: { getSessionName: () => undefined },
		session: {
			isCompacting: false,
			isStreaming: false,
			runIdleCompaction,
			agent: { state: { messages: [createAssistantMessage()] } },
		},
		get viewSession() {
			return this.session;
		},
		clearTransientSessionUi: () => {},
	};
	const controller = new EventController(context as unknown as InteractiveModeContext);
	return { context, controller, runIdleCompaction };
}

describe("EventController idle compaction", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": true,
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 60,
			},
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("cancels scheduled idle compaction when disposed", async () => {
		const { controller, runIdleCompaction } = createIdleContext();
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		controller.dispose();
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).not.toHaveBeenCalled();
	});

	it("refuses to fire while the plan-review overlay awaits a decision", async () => {
		const { context, controller, runIdleCompaction } = createIdleContext();
		// Plan approval aborts the turn, so agent_end arms the timer before the
		// overlay opens — the gate must hold at fire time, not just at arm time.
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		context.planReviewActive = true;
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).not.toHaveBeenCalled();
	});

	it("does not arm during plan review and re-arms when the overlay closes", async () => {
		const { context, controller, runIdleCompaction } = createIdleContext();
		context.planReviewActive = true;
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(60_000);
		expect(runIdleCompaction).not.toHaveBeenCalled();

		context.planReviewActive = false;
		controller.rescheduleIdleCompaction();
		vi.advanceTimersByTime(60_000);
		expect(runIdleCompaction).toHaveBeenCalledTimes(1);
	});
});
