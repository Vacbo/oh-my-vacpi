import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

interface HarnessOptions {
	settings?: Partial<Record<string, unknown>>;
	hasBuiltIn?: boolean;
	tool?: unknown;
	activeToolNames?: string[];
}

function makeHarness(options: HarnessOptions = {}) {
	const calls: string[] = [];
	const beginContextExport = vi.fn((_task: string) => {
		calls.push("begin");
		return "wf-fixed-0000";
	});
	const controller = { beginContextExport };
	const activeToolNames = options.activeToolNames ?? ["read", "bash"];
	const session = {
		hasBuiltInTool: vi.fn((name: string) => name === "context_export" && (options.hasBuiltIn ?? true)),
		getToolByName: vi.fn((name: string) => (name === "context_export" ? (options.tool ?? controller) : undefined)),
		getActiveToolNames: vi.fn(() => [...activeToolNames]),
		setActiveToolsByName: vi.fn(async (_names: string[]) => {
			calls.push("activate");
		}),
	};
	const settings = Settings.isolated(options.settings ?? {});
	const outputs: string[] = [];
	const setText = vi.fn();
	const ctx = {
		session,
		sessionManager: { getCwd: () => "/tmp" },
		settings,
		showStatus: (text: string) => {
			outputs.push(text);
		},
		editor: { setText },
		refreshSlashCommandState: vi.fn(),
	} as unknown as InteractiveModeContext;
	const acpRuntime = {
		session,
		sessionManager: { getCwd: () => "/tmp" },
		settings,
		cwd: "/tmp",
		output: (text: string) => {
			outputs.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	} as unknown as SlashCommandRuntime;
	return { calls, session, beginContextExport, outputs, setText, ctx, acpRuntime };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("/context-export slash command", () => {
	it("shows exact usage on empty input and touches no session state", async () => {
		const harness = makeHarness();
		const handled = await executeBuiltinSlashCommand("/context-export", { ctx: harness.ctx });
		expect(handled).toBe(true);
		expect(harness.outputs).toEqual(["Usage: /context-export <task>"]);
		expect(harness.beginContextExport).not.toHaveBeenCalled();
		expect(harness.session.setActiveToolsByName).not.toHaveBeenCalled();
	});

	it("rejects oversized tasks with the exact contract message", async () => {
		const harness = makeHarness();
		await executeBuiltinSlashCommand(`/context-export ${"x".repeat(20_001)}`, { ctx: harness.ctx });
		expect(harness.outputs).toEqual(["Context export task must not exceed 20,000 characters."]);
		expect(harness.beginContextExport).not.toHaveBeenCalled();
	});

	it("reports a disabled tool distinctly from an unavailable one", async () => {
		const disabled = makeHarness({ settings: { "tools.disabledTools": ["context_export"] } });
		await executeBuiltinSlashCommand("/context-export task", { ctx: disabled.ctx });
		expect(disabled.outputs).toEqual(["The context_export tool is disabled for this session."]);
		expect(disabled.session.getToolByName).not.toHaveBeenCalled();

		const missing = makeHarness({ hasBuiltIn: false });
		await executeBuiltinSlashCommand("/context-export task", { ctx: missing.ctx });
		expect(missing.outputs).toEqual(["The built-in context_export tool is unavailable for this session."]);

		// An extension-shadowed tool lacks the controller surface.
		const shadowed = makeHarness({ tool: { name: "context_export" } });
		await executeBuiltinSlashCommand("/context-export task", { ctx: shadowed.ctx });
		expect(shadowed.outputs).toEqual(["The built-in context_export tool is unavailable for this session."]);
		expect(shadowed.beginContextExport).not.toHaveBeenCalled();
	});

	it("binds the exact task before one-time activation and returns the workflow prompt into the session", async () => {
		const harness = makeHarness();
		const result = await executeBuiltinSlashCommand('/context-export fix the "auth" bug', { ctx: harness.ctx });
		// `{ prompt }` → the TUI dispatcher returns the prompt string so it submits
		// as a turn in the ACTIVE session (context preservation contract).
		expect(typeof result).toBe("string");
		const prompt = result as string;
		expect(prompt).toContain(JSON.stringify('fix the "auth" bug'));
		expect(prompt).toContain(JSON.stringify("wf-fixed-0000"));
		expect(harness.beginContextExport).toHaveBeenCalledWith('fix the "auth" bug');
		// Controller bound BEFORE activation; activation appends exactly once.
		expect(harness.calls).toEqual(["begin", "activate"]);
		expect(harness.session.setActiveToolsByName).toHaveBeenCalledWith(["read", "bash", "context_export"]);
	});

	it("skips activation when the tool is already active but still rebinds the workflow", async () => {
		const harness = makeHarness({ activeToolNames: ["read", "context_export"] });
		const result = await executeBuiltinSlashCommand("/context-export refresh workflow", { ctx: harness.ctx });
		expect(typeof result).toBe("string");
		expect(harness.beginContextExport).toHaveBeenCalledWith("refresh workflow");
		expect(harness.session.setActiveToolsByName).not.toHaveBeenCalled();
	});

	it("produces the identical prompt through the ACP dispatcher, as a { prompt } result", async () => {
		const tui = makeHarness();
		const acp = makeHarness();
		const tuiResult = await executeBuiltinSlashCommand("/context-export same task", { ctx: tui.ctx });
		const acpResult = await executeAcpBuiltinSlashCommand("/context-export same task", acp.acpRuntime);
		expect(typeof tuiResult).toBe("string");
		expect(acpResult).not.toBe(false);
		if (acpResult === false || !("prompt" in acpResult)) {
			throw new Error("expected an ACP { prompt } result");
		}
		expect(acpResult.prompt).toBe(tuiResult as string);
	});

	it("instructs the agent on both selection bases, conversation-first grounding, and preview-before-write", async () => {
		const harness = makeHarness();
		const result = await executeBuiltinSlashCommand("/context-export prompt contract", { ctx: harness.ctx });
		const prompt = result as string;
		expect(prompt).toContain('`base: "none"`');
		expect(prompt).toContain('`base: "all"`');
		expect(prompt).toContain("preceding conversation");
		expect(prompt).toContain("immutable");
		const previewIndex = prompt.indexOf('`action: "preview"`');
		const writeIndex = prompt.indexOf('`action: "write"`');
		expect(previewIndex).toBeGreaterThan(-1);
		expect(writeIndex).toBeGreaterThan(previewIndex);
	});
});
