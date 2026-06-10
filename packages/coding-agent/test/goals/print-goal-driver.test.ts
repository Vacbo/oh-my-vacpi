/**
 * Contract: the headless print goal driver pumps continuation turns until the
 * goal reaches a terminal state, the turn cap hits, or the session errors,
 * and maps each outcome to a stable process exit code orchestrators parse.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { Goal, GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import {
	DEFAULT_PRINT_GOAL_TURNS,
	parsePrintGoalArgs,
	printGoalExitCode,
	runPrintGoalContinuation,
} from "@oh-my-pi/pi-coding-agent/modes/continuation/print-goal";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SILENT_ABORT_MARKER } from "@oh-my-pi/pi-coding-agent/session/messages";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "draft" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

function createGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "Ship the feature",
		status: "active",
		tokenBudget: undefined,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function activeState(goalOverrides: Partial<Goal> = {}): GoalModeState {
	return { enabled: true, mode: "active", goal: createGoal(goalOverrides) };
}

interface PromptCall {
	customType: string;
	content: string;
	display?: boolean;
	attribution?: string;
}

/** Minimal mock of AgentSession for the goal continuation pump. */
function createMockSession(options: {
	state?: GoalModeState;
	budgetReportedFor?: string;
	messages?: AssistantMessage[];
	onPrompt?: (callIndex: number, setState: (next: GoalModeState | undefined) => void) => void;
}) {
	let state = options.state;
	const setState = (next: GoalModeState | undefined) => {
		state = next;
	};
	const calls: PromptCall[] = [];
	const modeChanges: string[] = [];
	const customEntries: Array<{ type: string; data: Record<string, unknown> }> = [];
	const session = {
		state: { messages: options.messages ?? [] },
		getGoalModeState: () => state,
		setGoalModeState: setState,
		goalRuntime: {
			get snapshot() {
				return { wallClock: { lastAccountedAt: 0 }, budgetReportedFor: options.budgetReportedFor };
			},
			buildContinuationPrompt: () =>
				state?.enabled && state.goal.status === "active" ? `Continue: ${state.goal.objective}` : undefined,
		},
		promptCustomMessage: async (message: PromptCall) => {
			calls.push({ ...message });
			options.onPrompt?.(calls.length, setState);
		},
		sessionManager: {
			appendModeChange: (mode: string) => {
				modeChanges.push(mode);
			},
			appendCustomEntry: (type: string, data: Record<string, unknown>) => {
				customEntries.push({ type, data });
			},
		},
	};
	return {
		session: session as unknown as AgentSession,
		calls,
		modeChanges,
		customEntries,
		getState: () => state,
	};
}

describe("print goal driver — pump", () => {
	it("pumps continuations until completion and finalizes the goal", async () => {
		const completed: GoalModeState = {
			enabled: false,
			mode: "exiting",
			reason: "completed",
			goal: createGoal({ status: "complete", tokensUsed: 42 }),
		};
		const mock = createMockSession({
			state: activeState(),
			onPrompt: (callIndex, setState) => {
				if (callIndex === 2) setState(completed);
			},
		});

		const result = await runPrintGoalContinuation(mock.session, { objective: "Ship the feature", maxTurns: 10 });

		expect(result).toEqual({ outcome: "complete", turns: 2 });
		expect(mock.calls).toHaveLength(2);
		for (const call of mock.calls) {
			expect(call).toMatchObject({ customType: "goal-continuation", display: false, attribution: "agent" });
			expect(call.content).toContain("Ship the feature");
		}
		expect(mock.getState()).toBeUndefined();
		expect(mock.modeChanges).toEqual(["none"]);
		expect(mock.customEntries).toEqual([
			{
				type: "goal-completed",
				data: { objective: "Ship the feature", tokensUsed: 42, tokenBudget: undefined, timeUsedSeconds: 0 },
			},
		]);
	});

	it("stops at the turn cap while the goal stays active", async () => {
		const mock = createMockSession({ state: activeState() });

		const result = await runPrintGoalContinuation(mock.session, { objective: "Ship the feature", maxTurns: 3 });

		expect(result).toEqual({ outcome: "turn-cap", turns: 3 });
		expect(mock.calls).toHaveLength(3);
		expect(mock.customEntries).toHaveLength(0);
	});

	it("runs exactly one wrap-up turn for an unsteered budget-limited goal", async () => {
		const mock = createMockSession({
			state: { enabled: true, mode: "active", goal: createGoal({ status: "budget-limited", tokenBudget: 10 }) },
		});

		const result = await runPrintGoalContinuation(mock.session, { objective: "Ship the feature", maxTurns: 10 });

		expect(result).toEqual({ outcome: "budget-limited", turns: 1 });
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]).toMatchObject({ customType: "goal-budget-limit", display: false, attribution: "agent" });
		expect(mock.calls[0].content).toContain("Ship the feature");
	});

	it("reports complete when the model completes the goal during wrap-up", async () => {
		const completed: GoalModeState = {
			enabled: false,
			mode: "exiting",
			reason: "completed",
			goal: createGoal({ status: "complete", tokenBudget: 10, tokensUsed: 12 }),
		};
		const mock = createMockSession({
			state: { enabled: true, mode: "active", goal: createGoal({ status: "budget-limited", tokenBudget: 10 }) },
			onPrompt: (_callIndex, setState) => setState(completed),
		});

		const result = await runPrintGoalContinuation(mock.session, { objective: "Ship the feature", maxTurns: 10 });

		expect(result).toEqual({ outcome: "complete", turns: 1 });
		expect(mock.getState()).toBeUndefined();
		expect(mock.customEntries).toHaveLength(1);
	});

	it("skips the wrap-up turn when the mid-turn budget steer already fired", async () => {
		const mock = createMockSession({
			state: { enabled: true, mode: "active", goal: createGoal({ status: "budget-limited", tokenBudget: 10 }) },
			budgetReportedFor: "goal-1",
		});

		const result = await runPrintGoalContinuation(mock.session, { objective: "Ship the feature", maxTurns: 10 });

		expect(result).toEqual({ outcome: "budget-limited", turns: 0 });
		expect(mock.calls).toHaveLength(0);
	});

	it("reports dropped when goal state vanishes mid-pump", async () => {
		const mock = createMockSession({
			state: activeState(),
			onPrompt: (_callIndex, setState) => setState(undefined),
		});

		const result = await runPrintGoalContinuation(mock.session, { objective: "Ship the feature", maxTurns: 10 });

		expect(result).toEqual({ outcome: "dropped", turns: 1 });
		expect(mock.customEntries).toHaveLength(0);
	});

	it("stops without pumping when the last assistant message errored", async () => {
		const mock = createMockSession({
			state: activeState(),
			messages: [makeAssistantMessage({ stopReason: "error", errorMessage: "boom" })],
		});

		const result = await runPrintGoalContinuation(mock.session, { objective: "Ship the feature", maxTurns: 10 });

		expect(result).toEqual({ outcome: "error", turns: 0 });
		expect(mock.calls).toHaveLength(0);
	});

	it("ignores silent aborts and keeps pumping", async () => {
		const completed: GoalModeState = {
			enabled: false,
			mode: "exiting",
			reason: "completed",
			goal: createGoal({ status: "complete" }),
		};
		const mock = createMockSession({
			state: activeState(),
			messages: [makeAssistantMessage({ stopReason: "aborted", errorMessage: SILENT_ABORT_MARKER })],
			onPrompt: (_callIndex, setState) => setState(completed),
		});

		const result = await runPrintGoalContinuation(mock.session, { objective: "Ship the feature", maxTurns: 10 });

		expect(result).toEqual({ outcome: "complete", turns: 1 });
	});
});

describe("print goal driver — exit codes", () => {
	it("maps outcomes to the documented exit codes", () => {
		// Orchestrators branch on these exact values; changing one is a breaking change.
		expect(printGoalExitCode("complete")).toBe(0);
		expect(printGoalExitCode("error")).toBe(1);
		expect(printGoalExitCode("budget-limited")).toBe(2);
		expect(printGoalExitCode("turn-cap")).toBe(3);
		expect(printGoalExitCode("dropped")).toBe(4);
		expect(printGoalExitCode("paused")).toBe(5);
	});
});

describe("print goal driver — parsePrintGoalArgs", () => {
	it("returns none when no goal flags are present", () => {
		expect(parsePrintGoalArgs({})).toEqual({ kind: "none" });
	});

	it("rejects budget/turns without --goal", () => {
		const budgetOnly = parsePrintGoalArgs({ goalBudget: "100" });
		expect(budgetOnly.kind).toBe("error");
		const turnsOnly = parsePrintGoalArgs({ goalTurns: "5" });
		expect(turnsOnly.kind).toBe("error");
	});

	it("rejects an empty objective", () => {
		expect(parsePrintGoalArgs({ goal: "   " }).kind).toBe("error");
	});

	it("rejects non-positive or malformed numeric values", () => {
		expect(parsePrintGoalArgs({ goal: "x", goalBudget: "0" }).kind).toBe("error");
		expect(parsePrintGoalArgs({ goal: "x", goalBudget: "12abc" }).kind).toBe("error");
		expect(parsePrintGoalArgs({ goal: "x", goalTurns: "-3" }).kind).toBe("error");
	});

	it("applies the default turn cap and parses explicit values", () => {
		expect(parsePrintGoalArgs({ goal: "Ship it" })).toEqual({
			kind: "ok",
			options: { objective: "Ship it", tokenBudget: undefined, maxTurns: DEFAULT_PRINT_GOAL_TURNS },
		});
		expect(parsePrintGoalArgs({ goal: "Ship it", goalBudget: "5000", goalTurns: "10" })).toEqual({
			kind: "ok",
			options: { objective: "Ship it", tokenBudget: 5000, maxTurns: 10 },
		});
	});
});
