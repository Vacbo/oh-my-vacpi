import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { streamAnthropic } from "../src/providers/anthropic";
import { OUTPUT_FALLBACK_BUFFER } from "../src/stream";
import type { Context, Model, ModelSpec } from "../src/types";

const adaptiveSpec: ModelSpec<"anthropic-messages"> = {
	id: "claude-opus-4-7",
	name: "Claude Opus 4.7",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com/v1/messages",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 64_000,
};
// Sparse spec: buildModel derives the adaptive mode and the Opus 4.7 ladder.
const baseAdaptiveModel = buildModel(adaptiveSpec);

const baseContext: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

type CapturedParams = {
	max_tokens?: number;
	thinking?: { type?: string; budget_tokens?: number };
};

async function captureParams(
	model: Model<"anthropic-messages">,
	options: { thinkingEnabled?: boolean; maxTokens?: number } = {},
): Promise<CapturedParams> {
	const { promise, resolve } = Promise.withResolvers<CapturedParams>();
	void streamAnthropic(model, baseContext, {
		apiKey: "sk-ant-api-test",
		isOAuth: false,
		signal: abortedSignal(),
		thinkingEnabled: options.thinkingEnabled,
		maxTokens: options.maxTokens,
		onPayload: payload => {
			resolve(payload as CapturedParams);
			return undefined;
		},
	});
	return promise;
}

describe("Anthropic adaptive thinking — max_tokens ceiling", () => {
	it("lifts max_tokens to model.maxTokens for adaptive thinking when caller did not override", async () => {
		const params = await captureParams(baseAdaptiveModel, { thinkingEnabled: true });

		expect(params.thinking?.type).toBe("adaptive");
		// Without the adaptive branch the default would be 64_000 / 3 = 21_333,
		// which can truncate a long thinking + structured tool_use mid-emission.
		expect(params.max_tokens).toBe(baseAdaptiveModel.maxTokens);
	});

	it("respects an explicit caller-supplied maxTokens in adaptive mode", async () => {
		const explicit = 12_000;
		const params = await captureParams(baseAdaptiveModel, {
			thinkingEnabled: true,
			maxTokens: explicit,
		});

		expect(params.thinking?.type).toBe("adaptive");
		expect(params.max_tokens).toBe(explicit);
	});

	it("does not lift max_tokens when adaptive thinking is disabled", async () => {
		const params = await captureParams(baseAdaptiveModel, { thinkingEnabled: false });

		// Without active thinking, the buildParams default (model.maxTokens / 3) is preserved
		// and the adaptive branch is never entered.
		expect(params.max_tokens).toBe(Math.floor(baseAdaptiveModel.maxTokens / 3));
	});

	it("keeps the OUTPUT_FALLBACK_BUFFER behaviour for non-adaptive (budget) thinking", async () => {
		const budgetModel: Model<"anthropic-messages"> = buildModel({
			...adaptiveSpec,
			compat: { disableAdaptiveThinking: true },
		});
		const params = await captureParams(budgetModel, { thinkingEnabled: true });

		expect(params.thinking?.type).toBe("enabled");
		const budgetTokens = params.thinking?.budget_tokens ?? 0;
		expect(budgetTokens).toBeGreaterThan(0);
		// Budget-mode invariant: max_tokens MUST be at least budget + buffer (capped at
		// model.maxTokens). The buildParams default of model.maxTokens/3 may already
		// exceed that floor; either way we never go below it and never above the cap.
		const floor = Math.min(budgetTokens + OUTPUT_FALLBACK_BUFFER, budgetModel.maxTokens);
		expect(params.max_tokens ?? 0).toBeGreaterThanOrEqual(floor);
		expect(params.max_tokens ?? 0).toBeLessThanOrEqual(budgetModel.maxTokens);
	});
});
