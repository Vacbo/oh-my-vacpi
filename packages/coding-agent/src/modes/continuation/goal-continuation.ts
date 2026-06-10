/**
 * Goal continuation decision policy.
 *
 * Pure classification of "should the host pump another goal turn, and with
 * what prompt": shared by the interactive TUI pump and the headless print
 * driver. Hosts own mode gating (settings, flags); this module only reads
 * goal state. It never mutates the runtime: state transitions stay in
 * GoalRuntime.
 */
import type { GoalRuntime } from "../../goals/runtime";
import { renderGoalPrompt } from "../../goals/runtime";
import type { GoalModeState } from "../../goals/state";

/** Narrow surface of AgentSession the decision needs; AgentSession satisfies it structurally. */
export interface GoalContinuationSource {
	getGoalModeState(): GoalModeState | undefined;
	goalRuntime: Pick<GoalRuntime, "snapshot" | "buildContinuationPrompt">;
}

export type GoalStopReason = "no-goal" | "dropped" | "complete" | "paused" | "budget-limited";

export type GoalContinuationDecision =
	| { kind: "continue"; prompt: string }
	| { kind: "wrap-up"; prompt: string }
	| { kind: "stop"; reason: GoalStopReason };

export function decideGoalContinuation(source: GoalContinuationSource): GoalContinuationDecision {
	const state = source.getGoalModeState();
	if (!state) return { kind: "stop", reason: "no-goal" };
	if (state.mode === "exiting" || state.goal.status === "complete") return { kind: "stop", reason: "complete" };
	if (state.goal.status === "dropped") return { kind: "stop", reason: "dropped" };
	if (state.goal.status === "paused") return { kind: "stop", reason: "paused" };
	if (state.goal.status === "budget-limited") {
		// End-of-turn budget flush flips status silently; the model never saw a
		// wrap-up steer. Offer one final wrap-up turn. When the mid-turn steer
		// already fired (budgetReportedFor matches), the model has had its
		// wrap-up; stop.
		if (source.goalRuntime.snapshot.budgetReportedFor !== state.goal.id) {
			return { kind: "wrap-up", prompt: renderGoalPrompt("budget-limit", state.goal) };
		}
		return { kind: "stop", reason: "budget-limited" };
	}
	const prompt = source.goalRuntime.buildContinuationPrompt();
	if (!prompt) return { kind: "stop", reason: "no-goal" };
	return { kind: "continue", prompt };
}
