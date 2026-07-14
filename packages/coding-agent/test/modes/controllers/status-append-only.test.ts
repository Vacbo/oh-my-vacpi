import { beforeAll, describe, expect, it, vi } from "bun:test";
import { shouldEnableAppendOnlyContext } from "@oh-my-pi/pi-coding-agent/config/append-only-context-mode";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

interface RenderableBlock {
	render(width: number): string[];
}

function isRenderableBlock(value: unknown): value is RenderableBlock {
	return value !== null && typeof value === "object" && "render" in value && typeof value.render === "function";
}

function renderPresentedBlocks(value: unknown): string {
	const blocks = Array.isArray(value) ? value : [value];
	return Bun.stripANSI(
		blocks
			.filter(isRenderableBlock)
			.flatMap(block => block.render(120))
			.join("\n"),
	);
}

/** Minimal model shape the status renderer and the append-only resolver both read. */
interface StatusTestModel {
	id: string;
	api: string;
	provider: string;
	baseUrl: string;
	compatConfig?: { supportsStore: boolean };
}

interface AppendOnlyCase {
	name: string;
	model: StatusTestModel;
}

function createStatusHarness(model: StatusTestModel) {
	const present = vi.fn();
	const ctx = {
		session: {
			model,
			providerSessionState: new Map(),
			modelRegistry: {
				authStorage: {
					hasOAuth: () => false,
					has: () => false,
					hasAuth: () => false,
					describeCredentialSource: () => undefined,
				},
			},
			getSessionStats: () => ({
				sessionFile: "In-memory",
				sessionId: "test-session",
				userMessages: 0,
				assistantMessages: 0,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: 0,
				tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
				premiumRequests: 0,
			}),
		},
		settings: {
			get: (key: string) => {
				if (key === "provider.appendOnlyContext") return "auto";
				if (key === "providers.openaiWebsockets") return "auto";
				return undefined;
			},
		},
		present,
	} as unknown as InteractiveModeContext;
	return { ctx, present };
}

const APPEND_ONLY_CASES: AppendOnlyCase[] = [
	{
		name: "DeepSeek (provider allowlist)",
		model: {
			id: "deepseek-chat",
			api: "openai-completions",
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com",
		},
	},
	{
		name: "explicit compat supportsStore (full model required)",
		model: {
			id: "proxy-model",
			api: "openai-completions",
			provider: "generic-proxy",
			baseUrl: "https://llm.example.com/v1",
			compatConfig: { supportsStore: true },
		},
	},
	{
		name: "local loopback baseUrl",
		model: { id: "local-model", api: "openai-completions", provider: "my-vllm", baseUrl: "http://127.0.0.1:8000/v1" },
	},
	{
		name: "unsupported public provider",
		model: {
			id: "public-model",
			api: "openai-completions",
			provider: "generic-proxy",
			baseUrl: "https://llm.example.com/v1",
		},
	},
];

describe("CommandController /status append-only", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	for (const testCase of APPEND_ONLY_CASES) {
		it(`renders the append-only state from the runtime resolver: ${testCase.name}`, async () => {
			const { ctx, present } = createStatusHarness(testCase.model);
			const controller = new CommandController(ctx);

			await controller.handleSessionCommand();

			expect(present).toHaveBeenCalledTimes(1);
			const output = renderPresentedBlocks(present.mock.calls[0]?.[0]);

			// The runtime enables append-only via this exact resolver call
			// (agent-session `#syncAppendOnlyContext` / sdk `buildAgent`).
			const expectedActive = shouldEnableAppendOnlyContext("auto", testCase.model);
			const line = output
				.split("\n")
				.find(l => l.includes("Append-Only:"))
				?.trim();
			expect(line).toBeDefined();
			expect(line).toBe(
				expectedActive
					? `Append-Only: active (setting: auto (${testCase.model.provider}))`
					: `Append-Only: inactive (setting: auto (${testCase.model.provider}))`,
			);
		});
	}

	it("classifies each case the way runtime does", () => {
		const results = APPEND_ONLY_CASES.map(c => shouldEnableAppendOnlyContext("auto", c.model));
		// DeepSeek, compat supportsStore, and local loopback are active; the public proxy is not.
		expect(results).toEqual([true, true, true, false]);
	});
});
