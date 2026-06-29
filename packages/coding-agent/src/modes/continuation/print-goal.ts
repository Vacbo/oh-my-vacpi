/**
 * Headless goal driver for print mode (`omp -p --goal "<objective>"`).
 *
 * Seeds a GoalRuntime goal before the first turn, pumps continuation turns
 * after the initial prompts, and maps the terminal goal state to a process
 * exit code so orchestrators can branch on the outcome.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { Args } from "../../cli/args";
import type { AgentSession } from "../../session/agent-session";
import { isSilentAbort } from "../../session/messages";
import { decideGoalContinuation, type GoalStopReason } from "./goal-continuation";

export interface PrintGoalOptions {
	objective: string;
	tokenBudget?: number;
	/** Max auto-continuation turns (not counting `-p` initial prompts). */
	maxTurns: number;
}

export const DEFAULT_PRINT_GOAL_TURNS = 25;

export type PrintGoalOutcome = "complete" | "budget-limited" | "turn-cap" | "dropped" | "paused" | "error";

export function printGoalExitCode(outcome: PrintGoalOutcome): number {
	switch (outcome) {
		case "complete":
			return 0;
		case "error":
			return 1;
		case "budget-limited":
			return 2;
		case "turn-cap":
			return 3;
		case "dropped":
			return 4;
		case "paused":
			return 5;
	}
}

export type ParsedPrintGoalArgs =
	| { kind: "none" }
	| { kind: "ok"; options: PrintGoalOptions }
	| { kind: "error"; message: string };

function parsePositiveInt(raw: string): number | undefined {
	if (!/^\d+$/.test(raw)) return undefined;
	const value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value <= 0) return undefined;
	return value;
}

export function parsePrintGoalArgs(args: Pick<Args, "goal" | "goalBudget" | "goalTurns">): ParsedPrintGoalArgs {
	if (args.goal === undefined) {
		if (args.goalBudget !== undefined || args.goalTurns !== undefined) {
			return { kind: "error", message: "--goal-budget/--goal-turns require --goal" };
		}
		return { kind: "none" };
	}
	const objective = args.goal.trim();
	if (!objective) {
		return { kind: "error", message: "--goal requires a non-empty objective" };
	}
	let tokenBudget: number | undefined;
	if (args.goalBudget !== undefined) {
		tokenBudget = parsePositiveInt(args.goalBudget);
		if (tokenBudget === undefined) {
			return { kind: "error", message: `--goal-budget must be a positive integer, got "${args.goalBudget}"` };
		}
	}
	let maxTurns = DEFAULT_PRINT_GOAL_TURNS;
	if (args.goalTurns !== undefined) {
		const parsed = parsePositiveInt(args.goalTurns);
		if (parsed === undefined) {
			return { kind: "error", message: `--goal-turns must be a positive integer, got "${args.goalTurns}"` };
		}
		maxTurns = parsed;
	}
	return { kind: "ok", options: { objective, tokenBudget, maxTurns } };
}

/** Mirrors interactive #enterGoalMode minus TUI: tools swap order matters for the hidden goal tool. */
export async function seedPrintGoal(session: AgentSession, options: PrintGoalOptions): Promise<void> {
	const previousTools = session.getActiveToolNames().filter(name => name !== "goal");
	const state = await session.goalRuntime.createGoal({
		objective: options.objective,
		tokenBudget: options.tokenBudget,
	});
	await session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
	session.setGoalModeState(state);
}

function lastAssistantErrored(session: AgentSession): boolean {
	const messages = session.state.messages;
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant") return false;
	const assistant = last as AssistantMessage;
	if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") return false;
	return !isSilentAbort(assistant);
}

function stopOutcome(reason: GoalStopReason): PrintGoalOutcome {
	switch (reason) {
		case "complete":
			return "complete";
		case "budget-limited":
			return "budget-limited";
		case "paused":
			return "paused";
		// The driver only runs after seeding, so vanished state means the model
		// dropped the goal via the goal tool.
		case "no-goal":
		case "dropped":
			return "dropped";
	}
}

/** Mirrors interactive #exitGoalMode's completed branch (sans TUI/tool restore; the process exits next). */
function finalizeCompletion(session: AgentSession): void {
	const state = session.getGoalModeState();
	session.setGoalModeState(undefined);
	session.sessionManager.appendModeChange("none");
	session.sessionManager.appendCustomEntry("goal-completed", {
		objective: state?.goal?.objective,
		tokensUsed: state?.goal?.tokensUsed,
		tokenBudget: state?.goal?.tokenBudget,
		timeUsedSeconds: state?.goal?.timeUsedSeconds,
	});
}

export async function runPrintGoalContinuation(
	session: AgentSession,
	options: PrintGoalOptions,
): Promise<{ outcome: PrintGoalOutcome; turns: number }> {
	let turns = 0;
	while (true) {
		if (lastAssistantErrored(session)) return { outcome: "error", turns };
		const decision = decideGoalContinuation(session);
		if (decision.kind === "stop") {
			if (decision.reason === "complete") finalizeCompletion(session);
			return { outcome: stopOutcome(decision.reason), turns };
		}
		if (turns >= options.maxTurns) return { outcome: "turn-cap", turns };
		turns++;
		await session.promptCustomMessage({
			customType: decision.kind === "wrap-up" ? "goal-budget-limit" : "goal-continuation",
			content: decision.prompt,
			display: false,
			attribution: "agent",
		});
		if (decision.kind === "wrap-up") {
			// One wrap-up turn only, but honor a completion the model declared
			// during it.
			const after = decideGoalContinuation(session);
			if (after.kind === "stop" && after.reason === "complete") {
				finalizeCompletion(session);
				return { outcome: "complete", turns };
			}
			return { outcome: "budget-limited", turns };
		}
	}
}
