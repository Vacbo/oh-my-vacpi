import { describe, expect, it } from "bun:test";
import {
	buildToolRows,
	type ToolsDashboardSession,
	toggleDisabledTool,
	toggleEssentialTool,
} from "@oh-my-pi/pi-coding-agent/modes/components/extensions/tools-dashboard";
import { BUILTIN_TOOLS, type Tool } from "@oh-my-pi/pi-coding-agent/tools";
import * as z from "zod/v4";

function fakeTool(name: string, overrides: Partial<Tool> = {}): Tool {
	return {
		name,
		label: name,
		description: `${name} does things.\n\nSecond paragraph with details.`,
		parameters: z.object({ target: z.string() }),
		execute: async () => ({ content: [], details: undefined }),
		...overrides,
	} as Tool;
}

function fakeSession(options: { registry: Record<string, Tool>; active: string[] }): ToolsDashboardSession {
	return {
		getAllToolNames: () => Object.keys(options.registry),
		getActiveToolNames: () => options.active,
		getToolByName: name => options.registry[name],
		setActiveToolsByName: async () => {},
	};
}

describe("buildToolRows", () => {
	const registry = {
		read: fakeTool("read"),
		find: fakeTool("find"),
		mcp__srv__doit: fakeTool("mcp__srv__doit"),
		customx: fakeTool("customx", { label: "Custom X Runner" }),
		// Hidden infrastructure tools land in the registry but must not become rows.
		resolve: fakeTool("resolve"),
		yield: fakeTool("yield"),
	};
	const session = fakeSession({ registry, active: ["read", "mcp__srv__doit", "customx"] });

	it("lists every built-in plus the session's other tools, classified by origin", () => {
		const rows = buildToolRows(session, []);
		const byId = new Map(rows.map(row => [row.id, row]));

		for (const name of Object.keys(BUILTIN_TOOLS)) {
			const row = byId.get(`tool:${name}`);
			expect(row?.source.provider).toBe("builtin");
		}
		expect(byId.get("tool:mcp__srv__doit")?.source.provider).toBe("mcp");
		expect(byId.get("tool:customx")?.source.provider).toBe("custom");
		// Hidden/internal tools never become rows.
		expect(byId.has("tool:resolve")).toBe(false);
		expect(byId.has("tool:yield")).toBe(false);
	});

	it("appends the label only when it differs beyond case and separators", () => {
		const rows = buildToolRows(session, []);
		const byId = new Map(rows.map(row => [row.id, row]));

		// fakeTool labels equal the name: no redundant "(label)" suffix.
		expect(byId.get("tool:read")?.displayName).toBe("read");
		expect(byId.get("tool:customx")?.displayName).toBe("customx (Custom X Runner)");
	});

	it("maps session availability: active, available (registered, inactive), not loaded", () => {
		const rows = buildToolRows(session, []);
		const byId = new Map(rows.map(row => [row.id, row]));

		expect(byId.get("tool:read")?.trigger).toBe("active");
		expect(byId.get("tool:find")?.trigger).toBe("available");
		// A built-in absent from the registry (config-gated this session).
		expect(byId.get("tool:browser")?.trigger).toBe("not loaded");
	});

	it("marks disabled built-ins as item-disabled without touching MCP/custom rows", () => {
		const rows = buildToolRows(session, ["read", "mcp__srv__doit"]);
		const byId = new Map(rows.map(row => [row.id, row]));

		expect(byId.get("tool:read")?.state).toBe("disabled");
		expect(byId.get("tool:read")?.disabledReason).toBe("item-disabled");
		// The disable list only governs built-ins; an MCP name in it is inert.
		expect(byId.get("tool:mcp__srv__doit")?.state).toBe("active");
	});

	it("derives the inspector blurb from the first description paragraph", () => {
		const rows = buildToolRows(session, []);
		const read = rows.find(row => row.id === "tool:read");
		expect(read?.description).toBe("read does things.");
	});
});

describe("toggleDisabledTool", () => {
	it("adds, removes, and keeps the list sorted and deduplicated", () => {
		const disabled = toggleDisabledTool(["find"], "browser", false);
		expect(disabled).toEqual(["browser", "find"]);
		expect(toggleDisabledTool(disabled, "browser", true)).toEqual(["find"]);
		expect(toggleDisabledTool(["find", "find"], "find", false)).toEqual(["find"]);
	});
});

describe("toggleEssentialTool", () => {
	// Empty override means DEFAULT_ESSENTIAL_TOOL_NAMES; sorted that set is
	// [bash, edit, eval, glob, launch, read, write].
	it("materializes the essential defaults on first pin", () => {
		expect(toggleEssentialTool([], "find")).toEqual([
			"bash",
			"edit",
			"eval",
			"find",
			"glob",
			"launch",
			"read",
			"write",
		]);
	});

	it("unpins a default member starting from an empty override", () => {
		expect(toggleEssentialTool([], "bash")).toEqual(["edit", "eval", "glob", "launch", "read", "write"]);
	});

	it("normalizes back to [] when the result equals the defaults", () => {
		// Removing the lone extra lands back on the defaults.
		expect(toggleEssentialTool(["bash", "edit", "eval", "find", "glob", "launch", "read", "write"], "find")).toEqual(
			[],
		);
		// Re-pinning the one missing default also lands back on the defaults.
		expect(toggleEssentialTool(["bash", "edit", "eval", "glob", "read", "write"], "launch")).toEqual([]);
	});
});
