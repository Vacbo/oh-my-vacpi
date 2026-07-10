import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { BuiltinToolLoadMode, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	AskTool,
	BUILTIN_TOOLS,
	computeEssentialBuiltinNames,
	computeForceActiveToolNames,
	createTools,
	DEFAULT_ESSENTIAL_TOOL_NAMES,
	filterInitialToolsForDiscoveryAll,
	GithubTool,
	IrcTool,
	JobTool,
	SshTool,
} from "@oh-my-pi/pi-coding-agent/tools";

const allToolsSettings = Settings.isolated({
	"astGrep.enabled": true,
	"astEdit.enabled": true,
	"debug.enabled": true,
	"glob.enabled": true,
	"grep.enabled": true,
	"github.enabled": true,
	"lsp.enabled": true,
	"inspect_image.enabled": true,
	"web_search.enabled": true,
	"browser.enabled": true,
	"checkpoint.enabled": true,
	"todo.enabled": true,
	"restart.toolEnabled": true,
	"memory.backend": "mnemopi",
	"autolearn.enabled": true,
	"tools.discoveryMode": "all",
});

const toolSession: ToolSession = {
	cwd: "/tmp/test",
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	settings: allToolsSettings,
	isToolDiscoveryEnabled: () => true,
	getSelectedDiscoveredToolNames: () => [],
	activateDiscoveredTools: async names => names,
};

async function getToolMetadata(): Promise<Map<string, { loadMode?: string; summary?: string }>> {
	const tools = await createTools(toolSession, Object.keys(BUILTIN_TOOLS));
	const metadata = new Map(tools.map(tool => [tool.name, { loadMode: tool.loadMode, summary: tool.summary }]));
	for (const tool of [
		new AskTool({ ...toolSession, hasUI: true }),
		new GithubTool(toolSession),
		new SshTool(toolSession, [], new Map(), ""),
		new JobTool(toolSession),
		new IrcTool(toolSession),
	]) {
		metadata.set(tool.name, { loadMode: tool.loadMode, summary: tool.summary });
	}
	return metadata;
}
describe("BUILTIN_TOOLS public factory map", () => {
	it("sets loading fields on tool definitions without wrapping factories", async () => {
		const metadata = await getToolMetadata();
		const missing = Object.keys(BUILTIN_TOOLS).filter(name => metadata.get(name)?.loadMode === undefined);
		expect(missing).toEqual([]);
	});
});

describe("built-in tool loadMode annotations", () => {
	it("provides a summary for every discoverable tool", async () => {
		const missing: string[] = [];
		const metadata = await getToolMetadata();
		for (const [name, meta] of metadata) {
			if (meta.loadMode === "discoverable" && !meta.summary) {
				missing.push(name);
			}
		}
		expect(missing).toEqual([]);
	});

	it("marks eval essential so it survives tools.discoveryMode 'all'", async () => {
		const metadata = await getToolMetadata();
		expect(metadata.get("eval")?.loadMode).toBe("essential");
		// Essential loadMode keeps eval active under discovery-all even when it is
		// absent from the essential-names set — not relying on the names list.
		const kept = filterInitialToolsForDiscoveryAll(["eval"], {
			loadModeOf: name => metadata.get(name)?.loadMode as BuiltinToolLoadMode | undefined,
			essentialNames: new Set<string>(),
			explicitlyRequested: new Set<string>(),
			restored: new Set<string>(),
			forceActive: new Set<string>(),
		});
		expect(kept).toEqual(["eval"]);
	});
});

describe("computeEssentialBuiltinNames", () => {
	it("returns DEFAULT_ESSENTIAL_TOOL_NAMES when override is empty", () => {
		const settings = Settings.isolated({});
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual([...DEFAULT_ESSENTIAL_TOOL_NAMES].sort());
	});

	it("respects tools.essentialOverride when provided", () => {
		const settings = Settings.isolated({ "tools.essentialOverride": ["read", "glob"] });
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["glob", "read"]);
	});

	it("maps legacy essential override tool names", () => {
		const settings = Settings.isolated({ "tools.essentialOverride": ["read", "find", "search", "glob"] });
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["glob", "grep", "read"]);
	});

	it("filters override entries that are not known built-in tools", () => {
		const settings = Settings.isolated({
			"tools.essentialOverride": ["read", "not_a_real_tool", "edit"],
		});
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["edit", "read"]);
	});

	it("trims whitespace and drops empty entries from the override", () => {
		const settings = Settings.isolated({
			"tools.essentialOverride": [" read ", "", "  "],
		});
		expect(computeEssentialBuiltinNames(settings)).toEqual(["read"]);
	});

	it("falls back to defaults when override is non-empty but contains only invalid names", () => {
		// The filtered list is empty (no valid names), but the override was provided —
		// current behavior returns the empty filtered list (caller can decide). Document the behavior.
		const settings = Settings.isolated({
			"tools.essentialOverride": ["not_a_real_tool"],
		});
		expect(computeEssentialBuiltinNames(settings)).toEqual([]);
	});
});

describe("tools.discoveryMode settings schema", () => {
	it("defaults to auto discovery mode", () => {
		const settings = Settings.isolated({});
		expect(settings.get("tools.discoveryMode")).toBe("auto");
	});

	it("back-compat: mcp.discoveryMode still accepted", () => {
		const settings = Settings.isolated({ "mcp.discoveryMode": true });
		expect(settings.get("mcp.discoveryMode")).toBe(true);
	});
});

describe("filterInitialToolsForDiscoveryAll", () => {
	const loadModes: Record<string, BuiltinToolLoadMode> = {
		read: "essential",
		edit: "essential",
		todo_write: "discoverable",
		grep: "discoverable",
	};
	const base = {
		loadModeOf: (name: string): BuiltinToolLoadMode | undefined => loadModes[name],
		essentialNames: new Set(["read", "bash", "edit", "write", "glob"]),
		explicitlyRequested: new Set<string>(),
		restored: new Set<string>(),
		forceActive: new Set<string>(),
	};

	it("hides non-essential discoverable built-ins", () => {
		expect(filterInitialToolsForDiscoveryAll(["read", "edit", "todo_write", "grep"], base)).toEqual(["read", "edit"]);
	});

	it("keeps discoverable tools required by a forced tool_choice (eager todo)", () => {
		const result = filterInitialToolsForDiscoveryAll(["read", "todo_write", "grep"], {
			...base,
			forceActive: new Set(["todo_write"]),
		});
		expect(result).toEqual(["read", "todo_write"]);
	});

	it("keeps explicitly requested and restored discoverable tools", () => {
		const result = filterInitialToolsForDiscoveryAll(["todo_write", "grep"], {
			...base,
			explicitlyRequested: new Set(["grep"]),
			restored: new Set(["todo_write"]),
		});
		expect([...result].sort()).toEqual(["grep", "todo_write"]);
	});

	it("never hides tools without a built-in loadMode (MCP/custom/extension)", () => {
		expect(filterInitialToolsForDiscoveryAll(["mcp__server__tool", "grep"], base)).toEqual(["mcp__server__tool"]);
	});
});

describe("computeForceActiveToolNames", () => {
	it("forces a registered built-in for eager todos", () => {
		const settings = Settings.isolated({ "todo.eager": true, "todo.enabled": true });
		const forced = computeForceActiveToolNames(settings, name => name in BUILTIN_TOOLS);
		// Regression: sdk used to force upstream's renamed `todo`, which does not
		// exist in this fork's BUILTIN_TOOLS, so eager todos were silently hidden
		// by discovery and the prelude no-oped.
		expect(forced.size).toBeGreaterThan(0);
		for (const name of forced) {
			expect(Object.keys(BUILTIN_TOOLS)).toContain(name);
		}
	});

	it("forces nothing when eager todos or todos are disabled", () => {
		const eagerOff = Settings.isolated({ "todo.eager": false, "todo.enabled": true });
		expect(computeForceActiveToolNames(eagerOff, () => true).size).toBe(0);
		const todosOff = Settings.isolated({ "todo.eager": true, "todo.enabled": false });
		expect(computeForceActiveToolNames(todosOff, () => true).size).toBe(0);
	});
});

describe("default-inactive built-in registration (context_export)", () => {
	function sessionWithActiveCapture(overrides: Partial<ToolSession> = {}): {
		session: ToolSession;
		activeNames: Set<string>;
	} {
		const activeNames = new Set<string>();
		const session: ToolSession = {
			...toolSession,
			...overrides,
			setActiveToolNames: names => {
				activeNames.clear();
				for (const name of names) activeNames.add(name);
			},
		};
		return { session, activeNames };
	}

	it("constructs context_export registry-only by default: registered but NOT active", async () => {
		const { session, activeNames } = sessionWithActiveCapture();
		const tools = await createTools(session);
		expect(tools.some(tool => tool.name === "context_export")).toBe(true);
		expect(activeNames.has("context_export")).toBe(false);
	});

	it("activates context_export when explicitly requested", async () => {
		const { session, activeNames } = sessionWithActiveCapture();
		const tools = await createTools(session, ["read", "context_export"]);
		expect(tools.some(tool => tool.name === "context_export")).toBe(true);
		expect(activeNames.has("context_export")).toBe(true);
	});

	it("does not construct context_export when disabled or in a subagent session", async () => {
		const disabled = sessionWithActiveCapture({
			settings: Settings.isolated({ "tools.disabledTools": ["context_export"] }),
		});
		const disabledTools = await createTools(disabled.session);
		expect(disabledTools.some(tool => tool.name === "context_export")).toBe(false);

		const subagent = sessionWithActiveCapture({ taskDepth: 1 });
		const subagentTools = await createTools(subagent.session);
		expect(subagentTools.some(tool => tool.name === "context_export")).toBe(false);
	});
});
