import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BUILTIN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";

// Every built-in tool on the public omp:// surface must ship a docs/tools/<name>.md
// root doc. File names use underscores or hyphens; the test accepts either form so
// renaming the on-disk page does not require coordinating with the wire name.
const docsToolsDir = path.resolve(import.meta.dir, "../../../../docs/tools");

// Fork tools whose docs live under a different on-disk page name. `todo_write` is
// this fork's todo tool (upstream renamed theirs to `todo`); its behavior is
// documented at docs/tools/todo.md, so the sweep resolves the alias instead of
// demanding a duplicate page.
const TOOL_DOC_ALIASES: Readonly<Record<string, string>> = { todo_write: "todo" };

const expectedDocPaths = (name: string): string[] => {
	// An alias is authoritative: `todo_write` resolves to `todo`, so only
	// docs/tools/todo.md counts — a stray todo_write.md can't mask its deletion.
	const page = TOOL_DOC_ALIASES[name] ?? name;
	return [...new Set([`${page}.md`, `${page.replace(/_/g, "-")}.md`])].map(file => path.join(docsToolsDir, file));
};

// Fork-only tools intentionally kept off the public omp:// tool docs. Each is
// named explicitly (never a predicate or prefix) so the sweep still fails for any
// ordinary public built-in lacking docs: `context_export` is default-inactive (its
// schema reaches the model only after the /context-export surface activates it);
// `tui_observe`/`tui_drive` drive and introspect live OMP TUI sessions; `restart`
// restarts omp in place. None is part of the public tool surface.
const UNDOCUMENTED_BUILTIN_TOOLS: Record<string, true> = {
	context_export: true,
	tui_observe: true,
	tui_drive: true,
	restart: true,
};

const DOCUMENTED_BUILTIN_TOOL_NAMES = BUILTIN_TOOL_NAMES.filter(name => !(name in UNDOCUMENTED_BUILTIN_TOOLS));

// Custom tools injected by the SDK (`packages/coding-agent/src/sdk.ts`) when
// their settings are enabled. Built-in tool factories live in BUILTIN_TOOLS but
// these custom tools are not present there, so the coverage list is explicit.
const CUSTOM_TOOL_NAMES = ["generate_image", "tts"] as const;

describe("omp:// root docs coverage", () => {
	it.each([...DOCUMENTED_BUILTIN_TOOL_NAMES])("documents builtin tool %s", name => {
		const candidates = expectedDocPaths(name);
		const present = candidates.find(candidate => fs.existsSync(candidate));
		expect(
			present,
			`Missing docs/tools/<name>.md for built-in tool "${name}". Tried: ${candidates.join(", ")}.`,
		).toBeDefined();
	});

	it.each([...CUSTOM_TOOL_NAMES])("documents injected custom tool %s", name => {
		const candidates = expectedDocPaths(name);
		const present = candidates.find(candidate => fs.existsSync(candidate));
		expect(present, `Missing docs/tools/<name>.md for injected custom tool "${name}".`).toBeDefined();
	});

	// Keep the exemption/alias lists honest: a removed or renamed built-in must
	// surface here rather than silently masking a future coverage gap.
	it("exempts and aliases only real built-in tools", () => {
		const known = new Set<string>(BUILTIN_TOOL_NAMES);
		for (const name of Object.keys(UNDOCUMENTED_BUILTIN_TOOLS)) {
			expect(known.has(name), `Undocumented exemption "${name}" is not a built-in tool.`).toBe(true);
		}
		for (const name of Object.keys(TOOL_DOC_ALIASES)) {
			expect(known.has(name), `Doc alias "${name}" is not a built-in tool.`).toBe(true);
		}
	});
});
