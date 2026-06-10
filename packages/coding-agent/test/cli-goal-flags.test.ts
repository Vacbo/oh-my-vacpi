import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("parseArgs — --goal flags", () => {
	it("parses --goal with a value", () => {
		const result = parseArgs(["-p", "--goal", "Ship the feature", "hello"]);
		expect(result.goal).toBe("Ship the feature");
		expect(result.print).toBe(true);
		expect(result.messages).toEqual(["hello"]);
	});

	it("parses --goal=value form", () => {
		const result = parseArgs(["--goal=Ship it", "hello"]);
		expect(result.goal).toBe("Ship it");
		expect(result.messages).toEqual(["hello"]);
	});

	it("parses --goal-budget and --goal-turns as raw strings", () => {
		const result = parseArgs(["--goal", "x", "--goal-budget", "5000", "--goal-turns=10"]);
		expect(result.goalBudget).toBe("5000");
		expect(result.goalTurns).toBe("10");
	});

	it("defaults all goal flags to undefined", () => {
		const result = parseArgs(["hello"]);
		expect(result.goal).toBeUndefined();
		expect(result.goalBudget).toBeUndefined();
		expect(result.goalTurns).toBeUndefined();
	});

	it("does not let --goal consume an adjacent flag's value", () => {
		const result = parseArgs(["--goal", "objective", "--model", "opus"]);
		expect(result.goal).toBe("objective");
		expect(result.model).toBe("opus");
	});
});
