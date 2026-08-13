import { describe, expect, it } from "bun:test";

import { toFireworksPublicModelId, toFireworksWireModelId } from "@oh-my-pi/pi-catalog/fireworks-model-id";

describe("Fireworks model ID mapping", () => {
	it("maps public router IDs to the Fireworks router wire path", () => {
		expect(toFireworksWireModelId("routers/kimi-k2p5-turbo")).toBe("accounts/fireworks/routers/kimi-k2p5-turbo");
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
});
