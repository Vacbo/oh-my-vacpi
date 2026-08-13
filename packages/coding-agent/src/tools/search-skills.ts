import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import type { SkillsSettings } from "../config/settings";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import {
	buildSkillSearchIndex,
	SKILL_SEARCH_TOOL_NAME,
	type SkillSearchEntry,
	searchSkills,
} from "../extensibility/skill-search";
import { collectDiscoverableSkillEntries } from "../extensibility/skills";
import type { Theme } from "../modes/theme/theme";
import searchSkillsDescription from "../prompts/tools/search-skills.md" with { type: "text" };
import { framedBlock, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { formatCount, formatExpandHint, formatMoreItems, replaceTabs, TRUNCATE_LENGTHS } from "./render-utils";
import { ToolError } from "./tool-errors";

const DEFAULT_LIMIT = 8;
const SKILL_SEARCH_TITLE = "Skill Search";
const COLLAPSED_MATCH_LIMIT = 5;
const MATCH_NAME_LEN = 72;
const MATCH_DESCRIPTION_LEN = 96;

const searchSkillsSchema = type({
	query: type("string").describe("capability to look for"),
	"limit?": type("number.integer >= 1").describe("max matches"),
});

type SearchSkillsParams = typeof searchSkillsSchema.infer;

interface SearchSkillsMatch {
	name: string;
	description: string;
	/** `skill://<name>` — the model reads this to load the skill. */
	read: string;
	score: number;
}

export interface SearchSkillsDetails {
	query: string;
	limit: number;
	/** Size of the searched corpus: skills loaded but unlisted in the system prompt. */
	total_skills: number;
	skills: SearchSkillsMatch[];
}

/** The unlisted skills of this session, i.e. everything this tool can return. */
function discoverableEntries(session: ToolSession): SkillSearchEntry[] {
	const skillsSettings: SkillsSettings = {
		discoveryMode: session.settings.get("skills.discoveryMode"),
		pinnedSkills: session.settings.get("skills.pinnedSkills"),
	};
	return collectDiscoverableSkillEntries(session.skills ?? [], skillsSettings);
}

export function renderSearchSkillsDescription(discoverableSkillCount: number): string {
	return prompt.render(searchSkillsDescription, { discoverableSkillCount });
}

function renderMatchLines(match: SearchSkillsMatch, theme: Theme): string[] {
	const safeName = replaceTabs(match.name);
	const safeDescription = replaceTabs(match.description.trim());
	const meta = theme.fg("dim", `score ${match.score.toFixed(3)}`);
	const lines = [`${theme.fg("accent", truncateToWidth(safeName, MATCH_NAME_LEN))} ${meta}`];
	if (safeDescription) {
		lines.push(theme.fg("muted", truncateToWidth(safeDescription, MATCH_DESCRIPTION_LEN)));
	}
	return lines;
}

function renderMatchBullets(skills: SearchSkillsMatch[], expanded: boolean, theme: Theme): string[] {
	const shown = expanded ? skills.length : Math.min(skills.length, COLLAPSED_MATCH_LIMIT);
	const bullet = theme.fg("dim", theme.format.bullet);
	const lines: string[] = [];
	for (let i = 0; i < shown; i++) {
		const itemLines = renderMatchLines(skills[i]!, theme);
		lines.push(`${bullet} ${itemLines[0]}`);
		for (let j = 1; j < itemLines.length; j++) {
			lines.push(`  ${itemLines[j]}`);
		}
	}
	const remaining = skills.length - shown;
	if (remaining > 0) {
		const hint = formatExpandHint(theme, expanded, true);
		lines.push(`${theme.fg("muted", formatMoreItems(remaining, "skill"))}${hint ? ` ${hint}` : ""}`);
	}
	return lines;
}

function renderFallbackResult(text: string, theme: Theme): Component {
	const header = renderStatusLine({ icon: "warning", title: SKILL_SEARCH_TITLE }, theme);
	const bodyLines = (text || "Skill search completed")
		.split("\n")
		.map(line => theme.fg("dim", truncateToWidth(replaceTabs(line), TRUNCATE_LENGTHS.LINE)));
	return new Text([header, ...bodyLines].join("\n"), 0, 0);
}

/**
 * Ranks the skills that `skills.discoveryMode: "search"` keeps out of the system
 * prompt and returns `skill://<name>` URIs for the best matches.
 *
 * Pure lookup: it activates nothing, mutates no toolset, and persists no
 * selection. `loadMode = "essential"` keeps it top-level — a tool the model
 * would first have to discover could never be the entry point to discovery.
 */
export class SearchSkillsTool implements AgentTool<typeof searchSkillsSchema, SearchSkillsDetails> {
	readonly name = SKILL_SEARCH_TOOL_NAME;
	readonly approval = "read" as const;
	readonly label = "SearchSkills";
	readonly loadMode = "essential";
	get description(): string {
		return renderSearchSkillsDescription(discoverableEntries(this.session).length);
	}
	readonly parameters = searchSkillsSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	/** Registered only under search discovery; otherwise every skill is already listed in the prompt. */
	static createIf(session: ToolSession): SearchSkillsTool | null {
		if (session.settings.get("skills.discoveryMode") !== "search") return null;
		return new SearchSkillsTool(session);
	}

	async execute(
		_toolCallId: string,
		params: SearchSkillsParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchSkillsDetails, typeof searchSkillsSchema>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchSkillsDetails, typeof searchSkillsSchema>> {
		const query = params.query.trim();
		if (query.length === 0) {
			throw new ToolError("Query is required and must not be empty.");
		}
		const limit = params.limit ?? DEFAULT_LIMIT;
		const entries = discoverableEntries(this.session);
		if (entries.length === 0) {
			throw new ToolError(
				'No skills are hidden behind search in this session. Every loaded skill is already listed in the system prompt; set skills.discoveryMode to "search" to unlist the unpinned ones.',
			);
		}

		let ranked: Array<{ entry: SkillSearchEntry; score: number }>;
		try {
			ranked = searchSkills(buildSkillSearchIndex(entries), query, limit);
		} catch (error) {
			if (error instanceof Error) throw new ToolError(error.message);
			throw error;
		}

		const details: SearchSkillsDetails = {
			query,
			limit,
			total_skills: entries.length,
			skills: ranked.map(result => ({
				name: result.entry.name,
				description: result.entry.description,
				read: `skill://${result.entry.name}`,
				score: Number(result.score.toFixed(6)),
			})),
		};

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						query: details.query,
						skills: details.skills.map(({ name, description, read }) => ({ name, description, read })),
						match_count: details.skills.length,
						total_skills: details.total_skills,
					}),
				},
			],
			details,
		};
	}
}

export const searchSkillsRenderer = {
	renderCall(args: SearchSkillsParams, _options: RenderResultOptions, uiTheme: Theme): Component {
		const query = typeof args.query === "string" ? replaceTabs(args.query.trim()) : "";
		const meta = args.limit ? [`limit:${args.limit}`] : [];
		const header = renderStatusLine(
			{ icon: "pending", title: SKILL_SEARCH_TITLE, description: query || "(empty query)", meta },
			uiTheme,
		);
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SearchSkillsDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		if (!result.details) {
			const fallbackText = result.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.filter((text): text is string => typeof text === "string" && text.length > 0)
				.join("\n");
			return renderFallbackResult(fallbackText, uiTheme);
		}

		const { details } = result;
		const meta = [
			formatCount("match", details.skills.length),
			`${details.total_skills} unlisted`,
			`limit:${details.limit}`,
		];
		const header = renderStatusLine(
			{
				...(details.skills.length > 0
					? { iconOverride: uiTheme.fg("accent", uiTheme.symbol("icon.search")) }
					: { icon: "warning" as const }),
				title: SKILL_SEARCH_TITLE,
				description: truncateToWidth(replaceTabs(details.query), MATCH_NAME_LEN),
				meta,
			},
			uiTheme,
		);
		if (details.skills.length === 0) {
			return new Text(`${header}\n${uiTheme.fg("muted", "No matching skills found.")}`, 0, 0);
		}

		return framedBlock(uiTheme, width => ({
			header,
			sections: [{ lines: renderMatchBullets(details.skills, options.expanded ?? false, uiTheme) }],
			state: "success",
			borderColor: "borderMuted",
			applyBg: false,
			width,
		}));
	},

	mergeCallAndResult: true,
	inline: true,
};
