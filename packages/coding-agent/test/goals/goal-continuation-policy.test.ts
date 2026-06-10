/**
 * Contract: decideGoalContinuation classifies live GoalRuntime state into
 * continue / wrap-up / stop decisions shared by the interactive pump and the
 * headless print driver. Driven through a real GoalRuntime so the decisions
 * track actual state transitions (budget flips, completion, pause).
 */
import { describe, expect, it } from "bun:test";
import { GoalRuntime, type GoalRuntimeHost, renderGoalPrompt } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type { Goal, GoalModeState, GoalTokenUsage } from "@oh-my-pi/pi-coding-agent/goals/state";
import {
	decideGoalContinuation,
	type GoalContinuationDecision,
	type GoalContinuationSource,
} from "@oh-my-pi/pi-coding-agent/modes/continuation/goal-continuation";

function createUsage(overrides: Partial<GoalTokenUsage> = {}): GoalTokenUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		...overrides,
	};
}

function createGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "Refactor the tokenizer",
		status: "active",
		tokenBudget: undefined,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function createHarness(initial: { state?: GoalModeState; usage?: GoalTokenUsage; now?: number } = {}) {
	let state = initial.state ? { ...initial.state, goal: { ...initial.state.goal } } : undefined;
	let usage = createUsage(initial.usage);
	let now = initial.now ?? 0;
	const hiddenMessages: Array<{ customType: string; content: string; deliverAs?: "steer" | "followUp" | "nextTurn" }> =
		[];
	const host: GoalRuntimeHost = {
		getState: () => (state ? { ...state, goal: { ...state.goal } } : undefined),
		setState: next => {
			state = next ? { ...next, goal: { ...next.goal } } : undefined;
		},
		getCurrentUsage: () => createUsage(usage),
		emit: () => {},
		persist: () => {},
		sendHiddenMessage: async message => {
			hiddenMessages.push({ ...message });
		},
		now: () => now,
	};
	const runtime = new GoalRuntime(host);
	const source: GoalContinuationSource = {
		getGoalModeState: () => (state ? { ...state, goal: { ...state.goal } } : undefined),
		goalRuntime: runtime,
	};
	return {
		runtime,
		source,
		hiddenMessages,
		getState: () => (state ? { ...state, goal: { ...state.goal } } : undefined),
		setUsage: (next: Partial<GoalTokenUsage>) => {
			usage = createUsage(next);
		},
		advance: (ms: number) => {
			now += ms;
		},
	};
}

function expectKind<K extends GoalContinuationDecision["kind"]>(
	decision: GoalContinuationDecision,
	kind: K,
): Extract<GoalContinuationDecision, { kind: K }> {
	if (decision.kind !== kind) {
		throw new Error(`expected decision kind "${kind}", got "${decision.kind}"`);
	}
	return decision as Extract<GoalContinuationDecision, { kind: K }>;
}

describe("goal continuation policy", () => {
	it("stops with no-goal when no state exists", () => {
		const harness = createHarness();
		expect(decideGoalContinuation(harness.source)).toEqual({ kind: "stop", reason: "no-goal" });
	});

	it("continues an active goal with the continuation prompt", () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});
		const decision = expectKind(decideGoalContinuation(harness.source), "continue");
		expect(decision.prompt).toContain("Refactor the tokenizer");
	});

	it("stops with complete after the goal tool completes the goal", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});
		await harness.runtime.completeGoalFromTool();
		expect(decideGoalContinuation(harness.source)).toEqual({ kind: "stop", reason: "complete" });
	});

	it("stops with paused after the goal is paused", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});
		await harness.runtime.pauseGoal();
		expect(decideGoalContinuation(harness.source)).toEqual({ kind: "stop", reason: "paused" });
	});

	it("stops with dropped for restored stale dropped state", () => {
		const harness = createHarness({
			state: { enabled: false, mode: "active", goal: createGoal({ status: "dropped" }) },
		});
		expect(decideGoalContinuation(harness.source)).toEqual({ kind: "stop", reason: "dropped" });
	});

	it("offers a wrap-up when budget exhausts at end of turn without a steer", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal({ tokenBudget: 10, tokensUsed: 8 }) },
		});
		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.setUsage({ input: 5 });
		await harness.runtime.onAgentEnd();

		const state = harness.getState();
		expect(state?.goal.status).toBe("budget-limited");
		expect(harness.hiddenMessages).toHaveLength(0);

		const decision = expectKind(decideGoalContinuation(harness.source), "wrap-up");
		expect(state).toBeDefined();
		if (!state) throw new Error("state missing");
		expect(decision.prompt).toBe(renderGoalPrompt("budget-limit", state.goal));
	});

	it("stops with budget-limited when the mid-turn steer already fired", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal({ tokenBudget: 10, tokensUsed: 8 }) },
		});
		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.setUsage({ input: 5 });
		await harness.runtime.flushUsage("allowed");

		expect(harness.getState()?.goal.status).toBe("budget-limited");
		expect(harness.hiddenMessages).toHaveLength(1);
		expect(harness.hiddenMessages[0]).toMatchObject({ customType: "goal-budget-limit", deliverAs: "steer" });

		expect(decideGoalContinuation(harness.source)).toEqual({ kind: "stop", reason: "budget-limited" });
	});
});
