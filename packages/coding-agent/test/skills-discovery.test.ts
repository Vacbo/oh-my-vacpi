import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	collectDiscoverableSkillEntries,
	loadSkills,
	partitionSkillsForPrompt,
	type Skill,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import {
	applyArraySuggestion,
	formatSettingTextValue,
	getSettingDef,
	parseSettingArrayText,
	suggestArrayEntries,
} from "@oh-my-pi/pi-coding-agent/modes/components/settings-defs";
import { TextInputSubmenu } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SystemPromptToolMetadata } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import {
	buildDiscoverableToolSearchIndex,
	searchDiscoverableTools,
} from "@oh-my-pi/pi-coding-agent/tool-discovery/tool-index";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

function skill(name: string, overrides: Partial<Skill> = {}): Skill {
	return {
		name,
		description: `${name} does something useful`,
		filePath: `/tmp/skills/${name}/SKILL.md`,
		baseDir: `/tmp/skills/${name}`,
		source: "claude:user",
		...overrides,
	};
}

describe("partitionSkillsForPrompt", () => {
	const skills = [skill("git-helper"), skill("docker-builds"), skill("secret-skill", { hide: true })];

	it("lists every visible skill and discovers none outside search mode", () => {
		const partition = partitionSkillsForPrompt(skills, { discoveryMode: "all" }, true);
		expect(partition.listed.map(s => s.name)).toEqual(["git-helper", "docker-builds"]);
		expect(partition.discoverable).toEqual([]);

		// Undefined settings behave like "all".
		const fallback = partitionSkillsForPrompt(skills, undefined, true);
		expect(fallback.listed.map(s => s.name)).toEqual(["git-helper", "docker-builds"]);
		expect(fallback.discoverable).toEqual([]);
	});

	it("splits pinned from discoverable in search mode and keeps hidden skills in neither", () => {
		const partition = partitionSkillsForPrompt(skills, { discoveryMode: "search", pinnedSkills: ["git-*"] }, true);
		expect(partition.listed.map(s => s.name)).toEqual(["git-helper"]);
		expect(partition.discoverable.map(s => s.name)).toEqual(["docker-builds"]);
		// Frontmatter-hidden skills must stay explicitly opt-in: not listed, not discoverable.
		const allNames = [...partition.listed, ...partition.discoverable].map(s => s.name);
		expect(allNames).not.toContain("secret-skill");
	});

	it("refuses to hide skills when the search tool is unavailable", () => {
		const partition = partitionSkillsForPrompt(skills, { discoveryMode: "search", pinnedSkills: [] }, false);
		// Hiding without a search path would make skills unreachable.
		expect(partition.listed.map(s => s.name)).toEqual(["git-helper", "docker-builds"]);
		expect(partition.discoverable).toEqual([]);
	});
});

describe("collectDiscoverableSkillEntries", () => {
	it("maps discovery-hidden skills to skill-source corpus entries", () => {
		const entries = collectDiscoverableSkillEntries(
			[skill("caveman", { description: "Ultra-compressed communication mode" }), skill("pinned-one")],
			{ discoveryMode: "search", pinnedSkills: ["pinned-*"] },
		);
		expect(entries).toEqual([
			{
				name: "skill:caveman",
				label: "caveman",
				summary: "Ultra-compressed communication mode",
				source: "skill",
				schemaKeys: [],
			},
		]);
	});

	it("returns nothing outside search mode", () => {
		expect(collectDiscoverableSkillEntries([skill("caveman")], { discoveryMode: "all" })).toEqual([]);
		expect(collectDiscoverableSkillEntries([skill("caveman")], undefined)).toEqual([]);
	});
});

describe("system prompt skill discovery roster", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-discovery-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-discovery-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	const promptTools = new Map<string, SystemPromptToolMetadata>([
		["read", { label: "Read", description: "Read files" }],
		["search_tool_bm25", { label: "SearchTools", description: "Discover hidden tools" }],
	]);

	it("collapses unpinned skills into a roster line under search mode", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [skill("pinned-skill"), skill("hidden-alpha"), skill("hidden-beta")],
			skillsSettings: { discoveryMode: "search", pinnedSkills: ["pinned-*"] },
			rules: [],
			tools: promptTools,
			toolNames: ["read", "search_tool_bm25"],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		const rendered = systemPrompt.join("\n\n");
		expect(rendered).toContain("- pinned-skill: pinned-skill does something useful");
		expect(rendered).not.toContain("hidden-alpha");
		expect(rendered).not.toContain("hidden-beta");
		expect(rendered).toContain("<skills-discovery>");
		expect(rendered).toContain("2 more skills are loaded but unlisted");
	});

	it("keeps the full listing and omits the roster outside search mode", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [skill("pinned-skill"), skill("hidden-alpha")],
			skillsSettings: {},
			rules: [],
			tools: promptTools,
			toolNames: ["read", "search_tool_bm25"],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		const rendered = systemPrompt.join("\n\n");
		expect(rendered).toContain("- pinned-skill:");
		expect(rendered).toContain("- hidden-alpha:");
		expect(rendered).not.toContain("<skills-discovery>");
	});
});

describe("skill body indexing", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-body-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-body-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
		const dir = path.join(tempDir, ".omp", "skills", "humanizer");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "SKILL.md"),
			`---
name: humanizer
description: Edit text for natural tone.
---

# Humanizer

Removes robotic phrasing so writing sounds less like an AI assistant wrote it.
${"filler ".repeat(600)}
`,
		);
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	const loadFlags = {
		enableCodexUser: false,
		enableClaudeUser: false,
		enableClaudeProject: false,
		enablePiUser: false,
		enablePiProject: true,
	} as const;

	it("retains a capped body excerpt only under search discovery", async () => {
		const searchLoad = await loadSkills({ cwd: tempDir, ...loadFlags, discoveryMode: "search" });
		const indexed = searchLoad.skills.find(s => s.name === "humanizer");
		expect(indexed?.searchText).toContain("robotic phrasing");
		expect(indexed?.searchText?.length).toBeLessThanOrEqual(2000);

		const defaultLoad = await loadSkills({ cwd: tempDir, ...loadFlags });
		expect(defaultLoad.skills.find(s => s.name === "humanizer")?.searchText).toBeUndefined();
	});

	it("matches skills through body text absent from name and description", () => {
		const entries = collectDiscoverableSkillEntries(
			[
				skill("humanizer", {
					description: "Edit text for natural tone.",
					searchText: "Removes robotic phrasing so writing sounds less like an AI assistant wrote it.",
				}),
				skill("database", { description: "PostgreSQL table design and migrations." }),
			],
			{ discoveryMode: "search" },
		);
		const index = buildDiscoverableToolSearchIndex(entries);
		const top = searchDiscoverableTools(index, "robotic ai phrasing", 1);
		expect(top[0]?.tool.name).toBe("skill:humanizer");
	});
});

describe("array settings in the TUI panel", () => {
	it("exposes skills.pinnedSkills as a text input on the tools tab", () => {
		const def = getSettingDef("skills.pinnedSkills");
		expect(def?.type).toBe("text");
		expect(def?.tab).toBe("tools");
	});

	it("round-trips comma-separated array values", () => {
		expect(parseSettingArrayText(" cmux* , caveman ,, slide-* ")).toEqual(["cmux*", "caveman", "slide-*"]);
		expect(formatSettingTextValue(["cmux*", "caveman"])).toBe("cmux*, caveman");
		expect(formatSettingTextValue([])).toBe("");
	});
});

describe("array entry suggestions", () => {
	const pool = ["caveman", "cmux-drive", "cmux-observe", "humanizer", "slide-deck", "tdd-loop"];

	it("fuzzy-ranks the typed segment with the closest name first", () => {
		const state = suggestArrayEntries("cav", pool);
		expect(state.items[0]).toBe("caveman");
		expect(suggestArrayEntries("cm", pool).items[0]?.startsWith("cmux")).toBe(true);
	});

	it("previews glob matches and counts the union across segments", () => {
		const state = suggestArrayEntries("cmux*", pool);
		expect(state.items).toEqual(["cmux-drive", "cmux-observe"]);
		expect(state.matchCount).toBe(2);

		// caveman is matched by both "caveman" and "cave*" — counted once; already
		// covered names are not re-suggested.
		const overlapping = suggestArrayEntries("cmux*, caveman, cave*", pool);
		expect(overlapping.matchCount).toBe(3);
		expect(overlapping.items).toEqual([]);
	});

	it("does not re-suggest names covered by committed segments", () => {
		// "cm" matches only the cmux-* entries (prefix); upstream word-local token
		// gating keeps it from loosely matching "caveman" (span c…m = 5 > maxSpan
		// 4). Both cmux entries are already covered by the committed "cmux*", so
		// nothing is left to suggest — without covered-filtering "cm" would surface
		// ["cmux-drive", "cmux-observe"].
		const state = suggestArrayEntries("cmux*, cm", pool);
		expect(state.items).toEqual([]);
	});

	it("caps suggestions at the limit and clears them between segments", () => {
		expect(suggestArrayEntries("c", pool, 2).items).toHaveLength(2);
		expect(suggestArrayEntries("cmux*, ", pool)).toEqual({ items: [], matchCount: 2, poolSize: 6 });
		expect(suggestArrayEntries("", pool)).toEqual({ items: [], matchCount: 0, poolSize: 6 });
	});

	it("applies a suggestion over the in-progress segment and primes the next one", () => {
		expect(applyArraySuggestion("cmux*, hum", "humanizer")).toBe("cmux*, humanizer, ");
		expect(applyArraySuggestion("", "caveman")).toBe("caveman, ");
	});
});

describe("TextInputSubmenu suggestions", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	const pool = ["caveman", "cmux-drive", "cmux-observe", "humanizer"];
	const noop = () => {};

	function submenu(initial = ""): TextInputSubmenu {
		return new TextInputSubmenu("Pinned Skills", "", initial, noop, noop, { pool, noun: "skills" });
	}

	it("accepts the top suggestion with Tab and resets the list", () => {
		const input = submenu();
		for (const ch of "hum") input.handleInput(ch);
		expect(input.suggestions[0]).toBe("humanizer");
		input.handleInput("\t");
		expect(input.getValue()).toBe("humanizer, ");
		expect(input.suggestions).toEqual([]);
	});

	it("cycles the selection with arrow keys before accepting", () => {
		const input = submenu();
		input.handleInput("c");
		const second = input.suggestions[1];
		expect(second).toBeDefined();
		input.handleInput("\x1b[B"); // arrow down
		input.handleInput("\t");
		expect(input.getValue()).toBe(`${second}, `);
	});

	it("keeps plain text settings free of suggestions", () => {
		const input = new TextInputSubmenu("Path", "", "", noop, noop);
		for (const ch of "cave") input.handleInput(ch);
		expect(input.suggestions).toEqual([]);
		expect(input.getValue()).toBe("cave");
	});
});
