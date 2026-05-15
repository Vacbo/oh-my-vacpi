import { describe, expect, it } from "bun:test";

import { getBundledModel } from "../src/models";
import { getEnvApiKeyForModel } from "../src/stream";
import { toFireworksPublicModelId, toFireworksWireModelId } from "../src/utils/fireworks-model-id";

describe("Fireworks model ID mapping", () => {
	it("maps public router IDs to the Fireworks router wire path", () => {
		expect(toFireworksWireModelId("routers/kimi-k2p5-turbo")).toBe("accounts/fireworks/routers/kimi-k2p5-turbo");
	});

	it("maps Kimi K2.6 Turbo Fire Pass router IDs to the Fireworks router wire path", () => {
		expect(toFireworksWireModelId("routers/kimi-k2.6-turbo")).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
	});

	it("preserves router wire IDs while normalizing version separators", () => {
		expect(toFireworksWireModelId("accounts/fireworks/routers/kimi-k2.5-turbo")).toBe(
			"accounts/fireworks/routers/kimi-k2p5-turbo",
		);
	});

	it("maps router wire IDs back to public router IDs", () => {
		expect(toFireworksPublicModelId("accounts/fireworks/routers/kimi-k2p5-turbo")).toBe("routers/kimi-k2.5-turbo");
	});

	it("keeps normal model IDs on the Fireworks model wire path", () => {
		expect(toFireworksWireModelId("llama-v3.1-8b-instruct")).toBe("accounts/fireworks/models/llama-v3p1-8b-instruct");
	});

	it("bundles Kimi K2.6 Turbo as a Fire Pass router model", () => {
		const model = getBundledModel("fireworks", "routers/kimi-k2.6-turbo");

		expect(model.id).toBe("routers/kimi-k2.6-turbo");
		expect(model.name).toBe("Kimi K2.6 Turbo (Fire Pass)");
		expect(model.contextWindow).toBe(256000);
		expect(model.maxTokens).toBe(256000);
		expect(model.cost.input).toBe(0);
		expect(model.cost.output).toBe(0);
	});

	it("uses the dedicated Fire Pass key for Kimi K2.6 Turbo", () => {
		const previousFireworksKey = Bun.env.FIREWORKS_API_KEY;
		const previousFirePassKey = Bun.env.FIREWORKS_PASS_API_KEY;
		Bun.env.FIREWORKS_API_KEY = "normal-fireworks-key";
		Bun.env.FIREWORKS_PASS_API_KEY = "fire-pass-key";
		try {
			expect(getEnvApiKeyForModel("fireworks", "routers/kimi-k2.6-turbo")).toBe("fire-pass-key");
			expect(getEnvApiKeyForModel("fireworks", "kimi-k2.6")).toBe("normal-fireworks-key");
		} finally {
			if (previousFireworksKey === undefined) {
				delete Bun.env.FIREWORKS_API_KEY;
			} else {
				Bun.env.FIREWORKS_API_KEY = previousFireworksKey;
			}
			if (previousFirePassKey === undefined) {
				delete Bun.env.FIREWORKS_PASS_API_KEY;
			} else {
				Bun.env.FIREWORKS_PASS_API_KEY = previousFirePassKey;
			}
		}
	});
});
