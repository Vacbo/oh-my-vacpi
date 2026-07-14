import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	discoverAuthStorage,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

const toolActivationExtension: ExtensionFactory = pi => {
	pi.registerTool({
		name: "default_inactive_tool",
		label: "Default Inactive Tool",
		description: "Tool hidden from the initial active set unless explicitly requested.",
		parameters: type({}),
		defaultInactive: true,
		async execute() {
			return { content: [{ type: "text", text: "inactive" }] };
		},
	});
	pi.registerTool({
		name: "default_active_tool",
		label: "Default Active Tool",
		description: "Tool included in the initial active set.",
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: "active" }] };
		},
	});
};

function createMcpCustomTool(name: string, serverName: string, mcpToolName: string): CustomTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description: `Tool ${mcpToolName} from ${serverName}`,
		mcpServerName: serverName,
		mcpToolName,
		parameters: type({ query: "string" }),
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as CustomTool;
}

describe("createAgentSession defaultInactive tool activation", () => {
	const tempDirs: string[] = [];

	// Built once and shared by every session. `ModelRegistry` eagerly loads all
	// bundled + cached models and `discoverAuthStorage` opens the auth DB — the
	// dominant (~50ms) slice of a cold boot, and identical for every test here.
	// Injecting it drops each per-test boot to the ~4ms of activation-specific work
	// these tests vary, and skips the background model refresh the SDK would
	// otherwise start when it builds its own registry.
	let modelRegistry!: ModelRegistry;
	let registryAuthDir: string;

	const makeTempDir = (): string => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	};

	beforeAll(async () => {
		registryAuthDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-auth-${Snowflake.next()}`);
		fs.mkdirSync(registryAuthDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir));
	});

	// Shared options for every session. `rules: []` and `workspaceTree` short-circuit
	// the two slow startup scans (rule discovery + native workspace walk, ~100ms each)
	// that are irrelevant to tool activation: these tests assert only which tools are
	// registered/active and that tool names appear in the system prompt. The shared
	// `modelRegistry` is injected here; each call still returns fresh
	// `settings`/`sessionManager` instances to keep tests isolated.
	const baseOptions = (tempDir: string): CreateAgentSessionOptions => ({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		rules: [],
		workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}

		vi.restoreAllMocks();
	});

	afterAll(() => {
		removeSyncWithRetries(registryAuthDir);
	});

	it("excludes defaultInactive extension tools from the initial active set unless explicitly requested", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [toolActivationExtension],
		});

		try {
			expect(session.getAllToolNames()).toEqual(
				expect.arrayContaining(["default_active_tool", "default_inactive_tool"]),
			);
			expect(session.getActiveToolNames()).toContain("default_active_tool");
			expect(session.getActiveToolNames()).not.toContain("default_inactive_tool");
			expect(session.systemPrompt.join("\n")).toContain("default_active_tool");
			expect(session.systemPrompt.join("\n")).not.toContain("default_inactive_tool");
		} finally {
			await session.dispose();
		}
	});

	it("allows explicitly requested defaultInactive extension tools into the initial active set", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [toolActivationExtension],
			toolNames: ["read", "default_inactive_tool"],
		});

		try {
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "default_active_tool", "default_inactive_tool"]),
			);
			expect(session.systemPrompt.join("\n")).toContain("default_inactive_tool");
		} finally {
			await session.dispose();
		}
	});

	it("activates the yield tool when requireYieldTool is set and toolNames is explicit", async () => {
		// Regression for #1408: plan-mode subagents pass an explicit `toolNames` list
		// (e.g. `["read", "grep", "glob", "lsp", "web_search"]`). Without this
		// invariant, `yield` ended up registered but not active, and the model
		// could not satisfy the idle-reminder contract that demands a `yield` call.
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			requireYieldTool: true,
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getActiveToolNames()).toContain("yield");
		} finally {
			await session.dispose();
		}
	});

	it("normalizes legacy builtin toolNames before selecting the active SDK tools", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "search", "find"],
		});

		try {
			const activeToolNames = session.getActiveToolNames();

			expect(activeToolNames).toContain("read");
			expect(activeToolNames).toContain("grep");
			expect(activeToolNames).toContain("glob");
			expect(activeToolNames).not.toContain("search");
			expect(activeToolNames).not.toContain("find");
		} finally {
			await session.dispose();
		}
	});

	it("keeps the hidden resolve tool registered for plan mode even when no deferrable tool is requested", async () => {
		// Regression for #1428: plan mode submits its finalized plan via
		// `resolve { action: "apply" }` dispatched through a standing handler
		// (interactive-mode.ts: `setStandingResolveHandler`). With an explicit
		// read-only `toolNames` (e.g. `read`, `search`, `find`, `web_search`)
		// the registry has no `deferrable` tool, so the previous gate dropped
		// `resolve` from the registry and plan mode silently activated without
		// it — leaving the agent stuck after drafting the plan.
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getToolByName("resolve")).toBeDefined();
		} finally {
			await session.dispose();
		}
	});

	it("drops the hidden resolve tool when neither a deferrable tool nor plan mode can use it", async () => {
		const tempDir = makeTempDir();

		const settings = Settings.isolated();
		settings.set("plan.enabled", false);

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings,
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getToolByName("resolve")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("registers vibe tools only during explicit vibe activation", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession(baseOptions(tempDir));
		const previousActiveToolNames = session.getActiveToolNames();

		try {
			for (const name of VIBE_TOOL_NAMES) {
				expect(session.getToolByName(name)).toBeUndefined();
			}

			await session.activateVibeTools(["read"]);
			for (const name of VIBE_TOOL_NAMES) {
				expect(session.getToolByName(name)).toBeDefined();
				expect(session.getActiveToolNames()).toContain(name);
			}

			await session.deactivateVibeTools(previousActiveToolNames);
			for (const name of VIBE_TOOL_NAMES) {
				expect(session.getToolByName(name)).toBeUndefined();
			}
			expect(session.getActiveToolNames()).toEqual(previousActiveToolNames);
		} finally {
			await session.dispose();
		}
	});

	it("preserves the MCP discovery selection and writes no persistence entry across a vibe round-trip", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			toolNames: ["read", "search_tool_bm25", "mcp__github_create_issue"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});

		try {
			// Select a second, discovered MCP tool so the selection set is non-trivial.
			await session.activateDiscoveredMCPTools(["mcp__slack_post_message"]);
			const mcpSelectedBefore = [...session.getSelectedMCPToolNames()].sort();
			expect(mcpSelectedBefore).toEqual(["mcp__github_create_issue", "mcp__slack_post_message"]);
			const previousActiveToolNames = session.getActiveToolNames();
			const selectionEntriesBefore = session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "mcp_tool_selection").length;

			// Enter vibe: the temporary read-only + vibe-tool slate must neither
			// rewrite the MCP selection set nor append a persistence entry.
			await session.activateVibeTools(["read"]);
			expect(session.getActiveToolNames()).not.toContain("mcp__github_create_issue");
			expect([...session.getSelectedMCPToolNames()].sort()).toEqual(mcpSelectedBefore);
			expect(session.sessionManager.getEntries().filter(entry => entry.type === "mcp_tool_selection").length).toBe(
				selectionEntriesBefore,
			);

			// Exit vibe: prior active set and MCP selection both return, still with
			// no persistence entry written for the slate transitions.
			await session.deactivateVibeTools(previousActiveToolNames);
			expect(session.getActiveToolNames()).toEqual(previousActiveToolNames);
			expect([...session.getSelectedMCPToolNames()].sort()).toEqual(mcpSelectedBefore);
			expect(session.sessionManager.getEntries().filter(entry => entry.type === "mcp_tool_selection").length).toBe(
				selectionEntriesBefore,
			);
		} finally {
			await session.dispose();
		}
	});

	it("keeps a BM25-activated builtin selected across a vibe round-trip and a resume", async () => {
		const tempDir = makeTempDir();
		const sessionOptions = {
			...baseOptions(tempDir),
			settings: Settings.isolated({ "tools.discoveryMode": "all" }),
		};
		const firstManager = SessionManager.create(tempDir, tempDir);
		const { session } = await createAgentSession({ ...sessionOptions, sessionManager: firstManager });

		// Discovery "all" hides discoverable builtins at assembly; BM25-activate one.
		expect(session.getActiveToolNames()).not.toContain("grep");
		expect(await session.activateDiscoveredTools(["grep"])).toEqual(["grep"]);
		const discoveredSelectedBefore = [...session.getSelectedDiscoveredToolNames()].sort();
		expect(discoveredSelectedBefore).toContain("grep");
		const previousActiveToolNames = session.getActiveToolNames();
		const selectionEntriesBefore = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "mcp_tool_selection").length;

		// Enter vibe: the slate must not prune the selection or persist an entry.
		await session.activateVibeTools(["read"]);
		expect(session.getActiveToolNames()).not.toContain("grep");
		expect(session.sessionManager.getEntries().filter(entry => entry.type === "mcp_tool_selection").length).toBe(
			selectionEntriesBefore,
		);

		// Exit vibe: prior active set and the builtin selection both return.
		await session.deactivateVibeTools(previousActiveToolNames);
		expect(session.getActiveToolNames()).toEqual(previousActiveToolNames);
		expect([...session.getSelectedDiscoveredToolNames()].sort()).toEqual(discoveredSelectedBefore);
		expect(session.sessionManager.getEntries().filter(entry => entry.type === "mcp_tool_selection").length).toBe(
			selectionEntriesBefore,
		);

		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		await session.sessionManager.rewriteEntries();
		await session.dispose();

		// Resume: the un-corrupted persisted selection must still restore grep,
		// proving the vibe round-trip left durable discovery state intact.
		const resumedManager = await SessionManager.open(sessionFile!, tempDir);
		const { session: resumedSession } = await createAgentSession({
			...sessionOptions,
			sessionManager: resumedManager,
		});
		try {
			expect(resumedSession.getActiveToolNames()).toContain("grep");
			expect(resumedSession.getSelectedDiscoveredToolNames()).toContain("grep");
		} finally {
			await resumedSession.dispose();
		}
	});

	it("does not register the xAI TTS tool unless enabled", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
		});

		try {
			expect(session.getToolByName("tts")).toBeUndefined();
			expect(session.getAllToolNames()).not.toContain("tts");
			expect(session.getActiveToolNames()).not.toContain("tts");
		} finally {
			await session.dispose();
		}
	});

	it("registers the xAI TTS tool when enabled", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings: Settings.isolated({ "speechgen.enabled": true }),
		});

		try {
			expect(session.getToolByName("tts")).toBeDefined();
			expect(session.getActiveToolNames()).toContain("tts");
		} finally {
			await session.dispose();
		}
	});

	it("registers context_export registry-only by default; explicit request or later activation enables it", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession(baseOptions(tempDir));

		try {
			// Registered as a built-in, but absent from the initial active set and
			// therefore from the model-facing prompt.
			expect(session.getAllToolNames()).toContain("context_export");
			expect(session.hasBuiltInTool("context_export")).toBe(true);
			expect(session.getActiveToolNames()).not.toContain("context_export");
			expect(session.systemPrompt.join("\n")).not.toContain("context_export");

			// The /context-export handler activates it by appending to the active set.
			await session.setActiveToolsByName([...session.getActiveToolNames(), "context_export"]);
			expect(session.getActiveToolNames()).toContain("context_export");
		} finally {
			await session.dispose();
		}

		const explicitDir = makeTempDir();
		const { session: explicitSession } = await createAgentSession({
			...baseOptions(explicitDir),
			toolNames: ["read", "context_export"],
		});

		try {
			expect(explicitSession.getActiveToolNames()).toContain("context_export");
		} finally {
			await explicitSession.dispose();
		}
	});
});
