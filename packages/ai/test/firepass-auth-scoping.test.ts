/**
 * Fire Pass credential scoping: the Kimi K2.6 Turbo router (`routers/kimi-k2.6-turbo`
 * / wire `accounts/fireworks/routers/kimi-k2p6-turbo`) authenticates through the
 * dedicated `FIREWORKS_PASS_API_KEY`, which the generic `fireworks` provider must
 * NOT surface. This guards the v16.5.0 merge regression where the Pass key was
 * added to `fireworks` `envVars`: a pass-only key then triggered unsupported
 * `/v1/models` discovery and could lose to unrelated stored Fireworks credentials.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { getEnvApiKeyForModel, getModelScopedEnvApiKey } from "../src/stream";
import { withEnv } from "./helpers";

const ROUTER_ID = "routers/kimi-k2.6-turbo";
const ROUTER_WIRE_ID = "accounts/fireworks/routers/kimi-k2p6-turbo";
const ORDINARY_ID = "kimi-k2.7-code";

// Clear both fireworks-domain env vars so ambient shell / ~/.env state cannot
// leak into precedence, availability, or discovery assertions.
const SUPPRESS_ENV = {
	FIREWORKS_API_KEY: undefined,
	FIREWORKS_PASS_API_KEY: undefined,
} as const;

describe("getModelScopedEnvApiKey", () => {
	test("returns the dedicated Fire Pass key only for the router model ids", async () => {
		await withEnv({ ...SUPPRESS_ENV, FIREWORKS_PASS_API_KEY: "fpk-pass", FIREWORKS_API_KEY: "fw-generic" }, () => {
			expect(getModelScopedEnvApiKey("fireworks", ROUTER_ID)).toBe("fpk-pass");
			expect(getModelScopedEnvApiKey("fireworks", ROUTER_WIRE_ID)).toBe("fpk-pass");
			// Ordinary Fireworks models have no model-scoped key — never the Pass key.
			expect(getModelScopedEnvApiKey("fireworks", ORDINARY_ID)).toBeUndefined();
			// The friendly router id under the separate `firepass` provider is not
			// the `fireworks` router, so it does not borrow the Pass key here.
			expect(getModelScopedEnvApiKey("firepass", "kimi-k2.6-turbo")).toBeUndefined();
			expect(getModelScopedEnvApiKey("fireworks", undefined)).toBeUndefined();
		});
	});
});

describe("getEnvApiKeyForModel (dedicated-or-generic)", () => {
	test("router selects the Pass key while ordinary models select the generic key", async () => {
		await withEnv({ ...SUPPRESS_ENV, FIREWORKS_PASS_API_KEY: "fpk-pass", FIREWORKS_API_KEY: "fw-generic" }, () => {
			expect(getEnvApiKeyForModel("fireworks", ROUTER_ID)).toBe("fpk-pass");
			expect(getEnvApiKeyForModel("fireworks", ORDINARY_ID)).toBe("fw-generic");
		});
	});

	test("a pass-only environment never lets an ordinary Fireworks model resolve a key", async () => {
		await withEnv({ ...SUPPRESS_ENV, FIREWORKS_PASS_API_KEY: "fpk-pass" }, () => {
			expect(getEnvApiKeyForModel("fireworks", ROUTER_ID)).toBe("fpk-pass");
			expect(getEnvApiKeyForModel("fireworks", ORDINARY_ID)).toBeUndefined();
		});
	});
});

describe("AuthStorage Fire Pass scoping", () => {
	let auth: AuthStorage;

	beforeEach(async () => {
		auth = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		auth.close();
	});

	describe("hasAuthForModel (model-aware availability)", () => {
		test("a pass-only environment exposes the router but not ordinary Fireworks", async () => {
			await withEnv({ ...SUPPRESS_ENV, FIREWORKS_PASS_API_KEY: "fpk-pass" }, () => {
				expect(auth.hasAuthForModel("fireworks", ROUTER_ID)).toBe(true);
				expect(auth.hasAuthForModel("fireworks", ORDINARY_ID)).toBe(false);
			});
		});

		test("no fireworks env at all leaves both the router and ordinary models unavailable", async () => {
			await withEnv(SUPPRESS_ENV, () => {
				expect(auth.hasAuthForModel("fireworks", ROUTER_ID)).toBe(false);
				expect(auth.hasAuthForModel("fireworks", ORDINARY_ID)).toBe(false);
			});
		});

		test("a stored (non-env) Fireworks credential exposes every Fireworks model", async () => {
			await withEnv(SUPPRESS_ENV, async () => {
				await auth.set("fireworks", { type: "api_key", key: "stored-generic" });
				expect(auth.hasAuthForModel("fireworks", ROUTER_ID)).toBe(true);
				expect(auth.hasAuthForModel("fireworks", ORDINARY_ID)).toBe(true);
			});
		});
	});

	describe("provider-level discovery scoping", () => {
		test("a pass-only key is invisible to generic peekApiKey / hasAuth (no /v1/models discovery)", async () => {
			await withEnv({ ...SUPPRESS_ENV, FIREWORKS_PASS_API_KEY: "fpk-pass" }, async () => {
				expect(await auth.peekApiKey("fireworks")).toBeUndefined();
				expect(auth.hasAuth("fireworks")).toBe(false);
			});
		});

		test("a generic key is visible to peekApiKey so ordinary discovery still runs", async () => {
			await withEnv({ ...SUPPRESS_ENV, FIREWORKS_API_KEY: "fw-generic" }, async () => {
				expect(await auth.peekApiKey("fireworks")).toBe("fw-generic");
				expect(auth.hasAuth("fireworks")).toBe(true);
			});
		});
	});

	describe("getApiKey request precedence", () => {
		test("pass-only: the router authenticates with the Pass key, ordinary models get nothing", async () => {
			await withEnv({ ...SUPPRESS_ENV, FIREWORKS_PASS_API_KEY: "fpk-pass" }, async () => {
				expect(await auth.getApiKey("fireworks", undefined, { modelId: ROUTER_ID })).toBe("fpk-pass");
				expect(await auth.getApiKey("fireworks", undefined, { modelId: ORDINARY_ID })).toBeUndefined();
			});
		});

		test("both keys: router uses Pass, ordinary uses the generic key", async () => {
			await withEnv(
				{ ...SUPPRESS_ENV, FIREWORKS_PASS_API_KEY: "fpk-pass", FIREWORKS_API_KEY: "fw-generic" },
				async () => {
					expect(await auth.getApiKey("fireworks", undefined, { modelId: ROUTER_ID })).toBe("fpk-pass");
					expect(await auth.getApiKey("fireworks", undefined, { modelId: ORDINARY_ID })).toBe("fw-generic");
				},
			);
		});

		test("a dedicated Pass key beats an unrelated stored Fireworks login for the router, but not for ordinary models", async () => {
			await withEnv({ ...SUPPRESS_ENV, FIREWORKS_PASS_API_KEY: "fpk-pass" }, async () => {
				await auth.set("fireworks", { type: "api_key", key: "stored-login", source: "login" });
				// Router: the model-scoped Pass key wins over the unrelated stored login.
				expect(await auth.getApiKey("fireworks", undefined, { modelId: ROUTER_ID })).toBe("fpk-pass");
				// Ordinary: generic precedence is unmoved — the stored login still wins.
				expect(await auth.getApiKey("fireworks", undefined, { modelId: ORDINARY_ID })).toBe("stored-login");
			});
		});

		test("explicit runtime and config overrides still outrank the Pass key for the router", async () => {
			await withEnv({ ...SUPPRESS_ENV, FIREWORKS_PASS_API_KEY: "fpk-pass" }, async () => {
				auth.setConfigApiKey("fireworks", "config-bearer");
				expect(await auth.getApiKey("fireworks", undefined, { modelId: ROUTER_ID })).toBe("config-bearer");
				auth.setRuntimeApiKey("fireworks", "runtime-bearer");
				expect(await auth.getApiKey("fireworks", undefined, { modelId: ROUTER_ID })).toBe("runtime-bearer");
			});
		});
	});
});
