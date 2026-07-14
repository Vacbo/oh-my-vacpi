/**
 * Model-aware availability for the Fire Pass router (`fireworks/routers/kimi-k2.6-turbo`).
 *
 * The dedicated `FIREWORKS_PASS_API_KEY` authorizes only the router model, not the
 * generic `fireworks` catalog. ModelRegistry availability is therefore resolved
 * per provider+model: a pass-only environment must expose the router while keeping
 * ordinary Fireworks models hidden (they would need `FIREWORKS_API_KEY`).
 *
 * Uses an isolated (empty) models.json path so the developer's real `models.yml`
 * — which may register a Fireworks credential — cannot leak into availability.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const ROUTER_ID = "routers/kimi-k2.6-turbo";
const ORDINARY_ID = "kimi-k2.7-code";

describe("ModelRegistry Fire Pass availability (model-aware)", () => {
	let authStorage: AuthStorage;
	let tempDir = "";
	let modelsJsonPath = "";
	let originalGeneric: string | undefined;
	let originalPass: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		originalGeneric = Bun.env.FIREWORKS_API_KEY;
		originalPass = Bun.env.FIREWORKS_PASS_API_KEY;
		delete Bun.env.FIREWORKS_API_KEY;
		delete Bun.env.FIREWORKS_PASS_API_KEY;
		tempDir = path.join(os.tmpdir(), `pi-test-firepass-avail-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		// Non-existent file in an empty dir: bundled catalog only, no custom config.
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		authStorage.close();
		if (originalGeneric === undefined) delete Bun.env.FIREWORKS_API_KEY;
		else Bun.env.FIREWORKS_API_KEY = originalGeneric;
		if (originalPass === undefined) delete Bun.env.FIREWORKS_PASS_API_KEY;
		else Bun.env.FIREWORKS_PASS_API_KEY = originalPass;
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
		resetSettingsForTest();
	});

	test("a pass-only environment exposes the Fire Pass router but hides ordinary Fireworks models", () => {
		Bun.env.FIREWORKS_PASS_API_KEY = "fpk-pass";
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const fireworksAvailable = registry
			.getAvailable()
			.filter(model => model.provider === "fireworks")
			.map(model => model.id);
		expect(fireworksAvailable).toContain(ROUTER_ID);
		expect(fireworksAvailable).not.toContain(ORDINARY_ID);
	});

	test("hasConfiguredAuth is model-aware in a pass-only environment", () => {
		Bun.env.FIREWORKS_PASS_API_KEY = "fpk-pass";
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const router = registry.find("fireworks", ROUTER_ID);
		const ordinary = registry.find("fireworks", ORDINARY_ID);
		if (!router || !ordinary) throw new Error("expected bundled fireworks router + ordinary models");
		expect(registry.hasConfiguredAuth(router)).toBe(true);
		expect(registry.hasConfiguredAuth(ordinary)).toBe(false);
	});

	test("a generic Fireworks key exposes ordinary Fireworks models", () => {
		Bun.env.FIREWORKS_API_KEY = "fw-generic";
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const ordinary = registry.find("fireworks", ORDINARY_ID);
		if (!ordinary) throw new Error("expected bundled ordinary fireworks model");
		expect(registry.hasConfiguredAuth(ordinary)).toBe(true);
	});
});
