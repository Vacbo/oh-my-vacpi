import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { streamAnthropic } from "../src/providers/anthropic";
import { OUTPUT_FALLBACK_BUFFER } from "../src/stream";
import type { Context, Model, ModelSpec } from "../src/types";

/**
 * Fork-owned contract file for `applyForkOutputBudget` in
 * src/providers/anthropic.ts: the /3 no-explicit-maxTokens default, the
 * OAuth-conditional Claude Code 64k cap interplay, and the adaptive-thinking
 * full-ceiling carve-out. Keeping these here leaves upstream's
 * anthropic-alignment.test.ts byte-mergeable across releases.
 */

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

// 128k output ceiling: the /3 default (42_666) lands below the 64k cap.
const bigModel = buildModel({
	...adaptiveSpec,
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	maxTokens: 128_000,
});

// 240k output ceiling: the /3 default (80_000) exceeds the 64k OAuth cap.
const hugeModel = buildModel({
	...adaptiveSpec,
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	maxTokens: 240_000,
});

// Sub-64k ceiling, non-adaptive shape.
const sonnetModel = buildModel({
	...adaptiveSpec,
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	maxTokens: 8_192,
});

// Budget (non-adaptive) thinking on the 64k ceiling.
const budgetModel: Model<"anthropic-messages"> = buildModel({
	...adaptiveSpec,
	compat: { disableAdaptiveThinking: true },
});

function requireMaxTokens(model: Model<"anthropic-messages">): number {
	if (model.maxTokens == null) {
		throw new Error(`Expected maxTokens on ${model.provider}/${model.id}`);
	}
	return model.maxTokens;
}

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
	options: { thinkingEnabled?: boolean; thinkingBudgetTokens?: number; maxTokens?: number; isOAuth?: boolean } = {},
): Promise<CapturedParams> {
	const isOAuth = options.isOAuth ?? false;
	const { promise, resolve } = Promise.withResolvers<CapturedParams>();
	void streamAnthropic(model, baseContext, {
		apiKey: isOAuth ? "sk-ant-oat-test" : "sk-ant-api-test",
		isOAuth,
		signal: abortedSignal(),
		thinkingEnabled: options.thinkingEnabled,
		thinkingBudgetTokens: options.thinkingBudgetTokens,
		maxTokens: options.maxTokens,
		onPayload: payload => {
			resolve(payload as CapturedParams);
			return undefined;
		},
	});
	return promise;
}

describe("Anthropic fork output budget — /3 default and caps", () => {
	it("defaults max_tokens to a third of the model ceiling when the caller does not pin one", async () => {
		const params = await captureParams(bigModel, { isOAuth: true });
		expect(params.max_tokens).toBe((128_000 / 3) | 0);
	});

	it("derives the default from a sub-64k model ceiling", async () => {
		const params = await captureParams(sonnetModel, { isOAuth: true });
		expect(params.max_tokens).toBe((8_192 / 3) | 0);
	});

	it("applies the /3 default to API-key requests too", async () => {
		const params = await captureParams(bigModel, { isOAuth: false });
		expect(params.max_tokens).toBe((128_000 / 3) | 0);
	});

	it("clamps the /3 default to the Claude Code 64k cap on OAuth requests", async () => {
		const params = await captureParams(hugeModel, { isOAuth: true });
		expect(params.max_tokens).toBe(64_000);
	});

	it("keeps the full /3 default above 64k for API-key requests", async () => {
		const params = await captureParams(hugeModel, { isOAuth: false });
		expect(params.max_tokens).toBe((240_000 / 3) | 0);
	});

	it("clamps an explicit OAuth maxTokens to the Claude Code 64k cap", async () => {
		const params = await captureParams(bigModel, { isOAuth: true, maxTokens: 128_000 });
		expect(params.max_tokens).toBe(64_000);
	});

	it("keeps the full model ceiling for explicit API-key maxTokens", async () => {
		// The 64k cap is OAuth-only fingerprint parity; API-key callers keep the
		// full catalog ceiling (contrast with the OAuth clamp test above).
		const params = await captureParams(bigModel, { isOAuth: false, maxTokens: 128_000 });
		expect(params.max_tokens).toBe(128_000);
	});
});

describe("Anthropic fork output budget — thinking interplay", () => {
	it("lifts max_tokens to the full ceiling for adaptive thinking when the caller did not override", async () => {
		const params = await captureParams(baseAdaptiveModel, { thinkingEnabled: true });

		expect(params.thinking?.type).toBe("adaptive");
		// Under the /3 default the ceiling would be 64_000 / 3 = 21_333, which can
		// truncate a long thinking burst plus a structured tool_use mid-emission.
		expect(params.max_tokens).toBe(requireMaxTokens(baseAdaptiveModel));
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

		// Without active thinking the /3 default is preserved and the adaptive
		// carve-out is never entered.
		expect(params.max_tokens).toBe(Math.floor(requireMaxTokens(baseAdaptiveModel) / 3));
	});

	it("raises the /3 default to fit an explicit enabled-thinking budget", async () => {
		const params = await captureParams(budgetModel, {
			thinkingEnabled: true,
			thinkingBudgetTokens: 30_000,
		});

		expect(params.thinking?.type).toBe("enabled");
		expect(params.thinking?.budget_tokens).toBe(30_000);
		// 30_000 + OUTPUT_FALLBACK_BUFFER exceeds the /3 default (21_333), so the
		// re-fit raises max_tokens to the budget floor instead of truncating.
		expect(params.max_tokens).toBe(30_000 + OUTPUT_FALLBACK_BUFFER);
	});

	it("clamps an enabled-thinking budget that exceeds the model ceiling", async () => {
		const params = await captureParams(budgetModel, {
			thinkingEnabled: true,
			thinkingBudgetTokens: 70_000,
		});

		expect(params.thinking?.type).toBe("enabled");
		expect(params.max_tokens).toBe(requireMaxTokens(budgetModel));
		expect(params.thinking?.budget_tokens).toBe(requireMaxTokens(budgetModel) - OUTPUT_FALLBACK_BUFFER);
	});

	it("keeps the OUTPUT_FALLBACK_BUFFER floor for the default thinking budget", async () => {
		const params = await captureParams(budgetModel, { thinkingEnabled: true });

		expect(params.thinking?.type).toBe("enabled");
		const budgetTokens = params.thinking?.budget_tokens ?? 0;
		expect(budgetTokens).toBeGreaterThan(0);
		// Budget-mode invariant: max_tokens MUST be at least budget + buffer (capped
		// at model.maxTokens). The /3 default may already exceed that floor; either
		// way we never go below it and never above the cap.
		const modelMaxTokens = requireMaxTokens(budgetModel);
		const floor = Math.min(budgetTokens + OUTPUT_FALLBACK_BUFFER, modelMaxTokens);
		expect(params.max_tokens ?? 0).toBeGreaterThanOrEqual(floor);
		expect(params.max_tokens ?? 0).toBeLessThanOrEqual(modelMaxTokens);
	});
});
