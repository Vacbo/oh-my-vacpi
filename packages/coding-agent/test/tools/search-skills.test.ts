import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SearchSkillsTool } from "@oh-my-pi/pi-coding-agent/tools/search-skills";

function skill(name: string, description: string, searchText?: string): Skill {
	return {
		name,
		description,
		filePath: `/tmp/skills/${name}/SKILL.md`,
		baseDir: `/tmp/skills/${name}`,
		source: "claude:user",
		...(searchText === undefined ? {} : { searchText }),
	};
}

const SKILLS = [
	skill("humanizer", "Edit text for a natural tone.", "Removes robotic phrasing so writing sounds less like an AI."),
	skill("depot-ci", "Configure and manage Depot CI workflows."),
	skill("cmux", "Control cmux windows, workspaces, and panes."),
	skill("secret-skill", "Never advertised.", undefined),
];

function createSession(
	overrides: { discoveryMode?: "all" | "search"; pinnedSkills?: string[]; skills?: readonly Skill[] } = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({
			"skills.discoveryMode": overrides.discoveryMode ?? "search",
			"skills.pinnedSkills": overrides.pinnedSkills ?? [],
		}),
		skills: overrides.skills ?? SKILLS,
	};
}

async function search(tool: SearchSkillsTool, query: string, limit?: number) {
	return await tool.execute("call-1", limit === undefined ? { query } : { query, limit });
}

describe("SearchSkillsTool.createIf", () => {
	it("registers only under search discovery", () => {
		expect(SearchSkillsTool.createIf(createSession({ discoveryMode: "search" }))).toBeInstanceOf(SearchSkillsTool);
		expect(SearchSkillsTool.createIf(createSession({ discoveryMode: "all" }))).toBeNull();
	});

	it("stays top-level so the model never has to discover the discovery tool", () => {
		const tool = SearchSkillsTool.createIf(createSession());
		expect(tool?.loadMode).toBe("essential");
		expect(tool?.name).toBe("search_skills");
	});
});

describe("SearchSkillsTool.execute", () => {
	it("returns skill:// URIs for the best matches and activates nothing", async () => {
		const tool = new SearchSkillsTool(createSession());
		const result = await search(tool, "make my writing sound less like an AI wrote it", 1);

		expect(result.details?.skills).toEqual([
			{
				name: "humanizer",
				description: "Edit text for a natural tone.",
				read: "skill://humanizer",
				score: expect.any(Number),
			},
		]);
		const [block] = result.content;
		if (block?.type !== "text") throw new Error("expected a single text content block");
		const payload = JSON.parse(block.text);
		expect(payload).toEqual({
			query: "make my writing sound less like an AI wrote it",
			skills: [{ name: "humanizer", description: "Edit text for a natural tone.", read: "skill://humanizer" }],
			match_count: 1,
			total_skills: 4,
		});
		// No toolset mutation surface: the result never reports activations.
		expect(payload).not.toHaveProperty("activated_tools");
	});

	it("matches on name and description, not only body text", async () => {
		const tool = new SearchSkillsTool(createSession());
		expect((await search(tool, "depot workflows", 1)).details?.skills[0]?.name).toBe("depot-ci");
		expect((await search(tool, "cmux panes", 1)).details?.skills[0]?.name).toBe("cmux");
	});

	it("excludes pinned skills: they are already listed in the system prompt", async () => {
		const tool = new SearchSkillsTool(createSession({ pinnedSkills: ["cmux", "depot-*"] }));
		const result = await search(tool, "cmux panes and depot workflows");

		expect(result.details?.total_skills).toBe(2);
		expect(result.details?.skills.map(match => match.name)).not.toContain("cmux");
		expect(result.details?.skills.map(match => match.name)).not.toContain("depot-ci");
	});

	it("never surfaces frontmatter-hidden skills", async () => {
		const hidden = [...SKILLS.slice(0, 3), { ...skill("secret-skill", "Never advertised."), hide: true }];
		const tool = new SearchSkillsTool(createSession({ skills: hidden }));
		const result = await search(tool, "never advertised secret");

		expect(result.details?.total_skills).toBe(3);
		expect(result.details?.skills.map(match => match.name)).not.toContain("secret-skill");
	});

	it("caps results at the limit and defaults to 8", async () => {
		const tool = new SearchSkillsTool(createSession());
		expect((await search(tool, "skill", 2)).details?.limit).toBe(2);
		expect((await search(tool, "cmux")).details?.limit).toBe(8);
	});

	it("rejects an unusable query or limit instead of returning an empty list", async () => {
		const tool = new SearchSkillsTool(createSession());
		await expect(search(tool, "   ")).rejects.toThrow("Query is required");
		await expect(search(tool, "!!!")).rejects.toThrow("at least one letter or number");
		// The schema already rejects a fractional limit; this guards the callers
		// that reach execute() directly (SDK, RPC host) and skip schema validation.
		await expect(search(tool, "cmux", 1.5)).rejects.toThrow("positive integer");
	});

	it("explains itself when search discovery hides nothing", async () => {
		const tool = new SearchSkillsTool(createSession({ discoveryMode: "all" }));
		await expect(search(tool, "cmux")).rejects.toThrow("No skills are hidden behind search");
	});

	it("reports the searchable count in its model-facing description", () => {
		expect(new SearchSkillsTool(createSession()).description).toContain("the remaining 4 are loaded but unlisted");
		expect(new SearchSkillsTool(createSession({ pinnedSkills: ["cmux"] })).description).toContain(
			"the remaining 3 are loaded but unlisted",
		);
	});
});
