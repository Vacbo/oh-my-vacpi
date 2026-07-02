import * as fs from "node:fs/promises";
import * as os from "node:os";
import { getProjectDir, prompt } from "@oh-my-pi/pi-utils";
import {
	isValidManagedSkillName,
	MANAGED_SKILLS_PROVIDER_ID,
	sanitizeManagedDescription,
} from "../autolearn/managed-skills";
import { skillCapability } from "../capability/skill";
import type { SourceMeta } from "../capability/types";
import type { SkillsSettings } from "../config/settings";
import { type Skill as CapabilitySkill, loadCapability } from "../discovery";
import { compareSkillOrder, scanSkillsFromDir } from "../discovery/helpers";
import autoloadTemplate from "../prompts/skills/autoload.md" with { type: "text" };
import userInvocationTemplate from "../prompts/skills/user-invocation.md" with { type: "text" };
import type { SkillPromptDetails } from "../session/messages";
import type { DiscoverableTool } from "../tool-discovery/tool-index";
import { expandTilde } from "../tools/path-utils";
export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: string;
	/**
	 * When `true`, the skill is loaded and reachable via `skill://<name>` and
	 * (when enabled) `/skill:<name>`, but is excluded from the rendered system
	 * prompt's `<skills>` listing.
	 */
	hide?: boolean;
	/**
	 * Capped SKILL.md body excerpt used only as BM25 corpus text for skill discovery.
	 * Populated at load time when `skills.discoveryMode === "search"`; never rendered.
	 */
	searchText?: string;
	/** Source metadata for display */
	_source?: SourceMeta;
}

export interface SkillWarning {
	skillPath: string;
	message: string;
}

export interface LoadSkillsResult {
	skills: Skill[];
	warnings: SkillWarning[];
}

let activeSkills: readonly Skill[] = [];

/**
 * Process-global snapshot of skills the active session loaded.
 * Read by internal URL protocol handlers (skill://).
 */
export function getActiveSkills(): readonly Skill[] {
	return activeSkills;
}

/** Replace the active skill snapshot. Called once per top-level session. */
export function setActiveSkills(value: readonly Skill[]): void {
	activeSkills = value;
}

/** Reset the active skill snapshot. Test-only. */
export function resetActiveSkillsForTests(): void {
	activeSkills = [];
}

/**
 * Whether `name` is already claimed by an active authored (non-managed) skill.
 *
 * Managed (auto-learn) skills resolve dead-last in discovery, so an authored
 * skill of the same name always wins (see `loadSkills`) and a managed skill
 * written under an authored name is silently dropped — it never surfaces.
 * `manage_skill` create consults this to refuse the write up front instead of
 * reporting a false "Created" for a skill that can never appear.
 */
export function isNameClaimedByAuthoredSkill(name: string): boolean {
	return getActiveSkills().some(
		skill => skill.name === name && skill._source?.provider !== MANAGED_SKILLS_PROVIDER_ID,
	);
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
}

export async function loadSkillsFromDir(options: LoadSkillsFromDirOptions): Promise<LoadSkillsResult> {
	const [rawProviderId, rawLevel] = options.source.split(":", 2);
	const providerId = rawProviderId || "custom";
	const level: "user" | "project" = rawLevel === "project" ? "project" : "user";
	const result = await scanSkillsFromDir(
		{ cwd: getProjectDir(), home: os.homedir(), repoRoot: null },
		{
			dir: options.dir,
			providerId,
			level,
			requireDescription: true,
		},
	);

	return {
		skills: result.items.map(capSkill => ({
			name: capSkill.name,
			description: typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
			filePath: capSkill.path,
			baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
			source: options.source,
			hide: capSkill.frontmatter?.hide === true || capSkill.frontmatter?.disableModelInvocation === true,
			_source: capSkill._source,
		})),
		warnings: (result.warnings ?? []).map(message => ({ skillPath: options.dir, message })),
	};
}

/** Cap on the SKILL.md body excerpt indexed for discovery search. */
const SKILL_SEARCH_TEXT_LIMIT = 2000;

/** Body excerpt for the discovery corpus; only retained when discovery search mode is on. */
function skillSearchText(
	content: string | undefined,
	discoveryMode: SkillsSettings["discoveryMode"],
): string | undefined {
	if (discoveryMode !== "search" || !content) return undefined;
	return content.slice(0, SKILL_SEARCH_TEXT_LIMIT);
}

export interface LoadSkillsOptions extends SkillsSettings {
	/** Working directory for project-local skills. Default: getProjectDir() */
	cwd?: string;
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation warnings.
 */
export async function loadSkills(options: LoadSkillsOptions = {}): Promise<LoadSkillsResult> {
	const {
		cwd = getProjectDir(),
		enabled = true,
		enableCodexUser = true,
		enableClaudeUser = true,
		enableClaudeProject = true,
		enablePiUser = true,
		enablePiProject = true,
		enableAgentsUser = true,
		enableAgentsProject = true,
		customDirectories = [],
		ignoredSkills = [],
		includeSkills = [],
		disabledExtensions = [],
		discoveryMode,
	} = options;

	// Early return if skills are disabled
	if (!enabled) {
		return { skills: [], warnings: [] };
	}
	// Fall-through gate for third-party CLI providers (claude-plugins, opencode,
	// gemini, github, ...) that share user intent with the named third-party
	// source toggles but don't have a dedicated control of their own. Only the
	// third-party toggles count here: the OMP-native providers (`agents`,
	// `native`) get explicit branches in `isSourceEnabled` below, so folding
	// them into the fallback would re-enable unrelated third-party CLIs whenever
	// the user kept the default `.agent[s]/skills` toggles on while turning off
	// Codex/Claude/Pi (issue #2401 / PR #2405 review).
	const anyThirdPartySkillToggleEnabled =
		enableCodexUser || enableClaudeUser || enableClaudeProject || enablePiUser || enablePiProject;

	function isSourceEnabled(source: SourceMeta): boolean {
		const { provider, level } = source;
		// Managed skills (auto-learn) are OMP-native and discovered unconditionally
		// — third-party CLI toggles must never silently hide them (cf. #2401). The
		// master `enabled` flag above still gates them.
		if (provider === MANAGED_SKILLS_PROVIDER_ID) return true;
		if (provider === "codex" && level === "user") return enableCodexUser;
		if (provider === "claude" && level === "user") return enableClaudeUser;
		if (provider === "claude" && level === "project") return enableClaudeProject;
		if (provider === "native" && level === "user") return enablePiUser;
		if (provider === "native" && level === "project") return enablePiProject;
		if (provider === "agents" && level === "user") return enableAgentsUser;
		if (provider === "agents" && level === "project") return enableAgentsProject;
		return anyThirdPartySkillToggleEnabled;
	}

	// Use capability API to load all skills
	const result = await loadCapability<CapabilitySkill>(skillCapability.id, { cwd, disabledExtensions });

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const collisionWarnings: SkillWarning[] = [];

	// Check if skill name matches any of the include patterns
	function matchesIncludePatterns(name: string): boolean {
		if (includeSkills.length === 0) return true;
		return includeSkills.some(pattern => new Bun.Glob(pattern).match(name));
	}

	// Check if skill name matches any of the ignore patterns
	function matchesIgnorePatterns(name: string): boolean {
		if (ignoredSkills.length === 0) return false;
		return ignoredSkills.some(pattern => new Bun.Glob(pattern).match(name));
	}

	const disabledSkillNames = new Set(
		(disabledExtensions ?? []).filter(id => id.startsWith("skill:")).map(id => id.slice(6)),
	);
	// Filter skills by source and patterns first
	const filteredSkills = result.items.filter(capSkill => {
		if (disabledSkillNames.has(capSkill.name)) return false;
		if (!isSourceEnabled(capSkill._source)) return false;
		if (matchesIgnorePatterns(capSkill.name)) return false;
		if (!matchesIncludePatterns(capSkill.name)) return false;
		return true;
	});

	// Batch resolve all real paths in parallel
	const realPaths = await Promise.all(
		filteredSkills.map(async capSkill => {
			try {
				return await fs.realpath(capSkill.path);
			} catch {
				return capSkill.path;
			}
		}),
	);

	// Process skills with resolved paths
	for (let i = 0; i < filteredSkills.length; i++) {
		const capSkill = filteredSkills[i];
		// Managed (auto-learn) skills are resolved dead-last (below) so any
		// authored skill of the same name — from ANY provider or custom dir — wins.
		if (capSkill._source.provider === MANAGED_SKILLS_PROVIDER_ID) continue;
		const resolvedPath = realPaths[i];

		// Skip silently if we've already loaded this exact file (via symlink)
		if (realPathSet.has(resolvedPath)) {
			continue;
		}

		const existing = skillMap.get(capSkill.name);
		if (existing) {
			collisionWarnings.push({
				skillPath: capSkill.path,
				message: `name collision: "${capSkill.name}" already loaded from ${existing.filePath}, skipping this one`,
			});
		} else {
			skillMap.set(capSkill.name, {
				name: capSkill.name,
				description: typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
				filePath: capSkill.path,
				baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
				source: `${capSkill._source.provider}:${capSkill.level}`,
				hide: capSkill.frontmatter?.hide === true || capSkill.frontmatter?.disableModelInvocation === true,
				searchText: skillSearchText(capSkill.content, discoveryMode),
				_source: capSkill._source,
			});
			realPathSet.add(resolvedPath);
		}
	}

	const customDirectoryResults = await Promise.all(
		customDirectories.map(async dir => {
			const expandedDir = expandTilde(dir);
			const scanResult = await scanSkillsFromDir(
				{ cwd, home: os.homedir(), repoRoot: null },
				{
					dir: expandedDir,
					providerId: "custom",
					level: "user",
					requireDescription: true,
				},
			);
			return { expandedDir, scanResult };
		}),
	);

	const allCustomSkills: Array<{ skill: Skill; path: string }> = [];
	for (const { expandedDir, scanResult } of customDirectoryResults) {
		for (const capSkill of scanResult.items) {
			if (disabledSkillNames.has(capSkill.name)) continue;
			if (matchesIgnorePatterns(capSkill.name)) continue;
			if (!matchesIncludePatterns(capSkill.name)) continue;
			allCustomSkills.push({
				skill: {
					name: capSkill.name,
					description:
						typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
					filePath: capSkill.path,
					baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
					source: "custom:user",
					hide: capSkill.frontmatter?.hide === true || capSkill.frontmatter?.disableModelInvocation === true,
					searchText: skillSearchText(capSkill.content, discoveryMode),
					_source: { ...capSkill._source, providerName: "Custom" },
				},
				path: capSkill.path,
			});
		}
		collisionWarnings.push(...(scanResult.warnings ?? []).map(message => ({ skillPath: expandedDir, message })));
	}

	const customRealPaths = await Promise.all(
		allCustomSkills.map(async ({ path }) => {
			try {
				return await fs.realpath(path);
			} catch {
				return path;
			}
		}),
	);

	for (let i = 0; i < allCustomSkills.length; i++) {
		const { skill } = allCustomSkills[i];
		const resolvedPath = customRealPaths[i];
		if (realPathSet.has(resolvedPath)) continue;

		const existing = skillMap.get(skill.name);
		if (existing) {
			collisionWarnings.push({
				skillPath: skill.filePath,
				message: `name collision: "${skill.name}" already loaded from ${existing.filePath}, skipping this one`,
			});
		} else {
			skillMap.set(skill.name, skill);
			realPathSet.add(resolvedPath);
		}
	}

	// Managed (auto-learn) skills resolve dead-last with first-wins. Source from
	// result.all (pre-dedup): capability-level dedup runs BEFORE isSourceEnabled,
	// so a managed skill can be shadowed by a higher-priority authored skill that
	// is itself disabled here — managed must stay visible regardless of toggles.
	// Validate the on-disk name (a hand-placed managed file could carry an unsafe
	// frontmatter name) and re-sanitize the description on read. Descriptions and
	// names both render unescaped into the system prompt.
	const managedCandidates = result.all.filter(
		capSkill =>
			capSkill._source.provider === MANAGED_SKILLS_PROVIDER_ID &&
			isValidManagedSkillName(capSkill.name) &&
			!disabledSkillNames.has(capSkill.name) &&
			!matchesIgnorePatterns(capSkill.name) &&
			matchesIncludePatterns(capSkill.name),
	);
	// Names claimed by any ENABLED authored skill (from the pre-dedup superset).
	// Managed defers to these even when capability dedup hid an enabled authored
	// skill behind a disabled higher-priority one, so managed never masks it.
	const enabledAuthoredNames = new Set(
		result.all
			.filter(
				capSkill => capSkill._source.provider !== MANAGED_SKILLS_PROVIDER_ID && isSourceEnabled(capSkill._source),
			)
			.map(capSkill => capSkill.name),
	);
	const managedRealPaths = await Promise.all(
		managedCandidates.map(async capSkill => {
			try {
				return await fs.realpath(capSkill.path);
			} catch {
				return capSkill.path;
			}
		}),
	);
	for (let i = 0; i < managedCandidates.length; i++) {
		const capSkill = managedCandidates[i];
		const resolvedPath = managedRealPaths[i];
		if (realPathSet.has(resolvedPath)) continue;
		if (enabledAuthoredNames.has(capSkill.name)) continue; // an enabled authored skill owns this name
		// Already claimed — e.g. by a custom-directory skill. LOAD-BEARING: custom
		// dirs never enter `result.all`, so they are absent from `enabledAuthoredNames`
		// above; this map check is the ONLY veto that lets a custom-dir authored skill
		// win over a same-named managed one. The custom-dir loop (which populates
		// skillMap, ~30 lines up) MUST run before this block — do not reorder.
		if (skillMap.has(capSkill.name)) continue;
		const rawDescription =
			typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "";
		skillMap.set(capSkill.name, {
			name: capSkill.name,
			description: sanitizeManagedDescription(rawDescription),
			filePath: capSkill.path,
			baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
			source: `${capSkill._source.provider}:${capSkill.level}`,
			hide: capSkill.frontmatter?.hide === true || capSkill.frontmatter?.disableModelInvocation === true,
			_source: capSkill._source,
		});
		realPathSet.add(resolvedPath);
	}

	const skills = Array.from(skillMap.values());
	// Deterministic ordering for prompt stability (case-insensitive, then exact name, then path).
	skills.sort((a, b) => compareSkillOrder(a.name, a.filePath, b.name, b.filePath));
	return {
		skills,
		warnings: [...(result.warnings ?? []).map(w => ({ skillPath: "", message: w })), ...collisionWarnings],
	};
}

export interface SkillPromptPartition {
	/** Skills rendered as summary lines in the system prompt `<skills>` listing. */
	listed: Skill[];
	/** Skills hidden from the listing but indexed in the `search_tool_bm25` BM25 corpus. */
	discoverable: Skill[];
}

/**
 * Split skills between the rendered `<skills>` listing and the BM25 discovery corpus.
 *
 * Frontmatter-hidden skills (`hide: true` / `disable-model-invocation: true`) land in
 * neither bucket: they stay explicitly opt-in via `/skill:<name>` and `skill://<name>`.
 * Discovery only applies when `skills.discoveryMode === "search"` AND the search tool is
 * actually available; otherwise hiding a skill would make it unreachable.
 */
export function partitionSkillsForPrompt(
	skills: readonly Skill[],
	settings: SkillsSettings | undefined,
	searchToolAvailable: boolean,
): SkillPromptPartition {
	const visible = skills.filter(skill => skill.hide !== true);
	if (settings?.discoveryMode !== "search" || !searchToolAvailable) {
		return { listed: visible, discoverable: [] };
	}
	const pinned = (settings.pinnedSkills ?? []).map(pattern => new Bun.Glob(pattern));
	const listed: Skill[] = [];
	const discoverable: Skill[] = [];
	for (const skill of visible) {
		(pinned.some(glob => glob.match(skill.name)) ? listed : discoverable).push(skill);
	}
	return { listed, discoverable };
}

/** Corpus entry name for a discoverable skill (mirrors the `/skill:<name>` command naming). */
export function discoverableSkillEntryName(skillName: string): string {
	return `skill:${skillName}`;
}

/**
 * Map discovery-hidden skills to BM25 corpus entries for `search_tool_bm25`.
 * Skill matches are never "activated": the search result carries the `skill://<name>`
 * URI and the model reads it directly; no toolset mutation, no persisted state.
 */
export function collectDiscoverableSkillEntries(
	skills: readonly Skill[],
	settings: SkillsSettings | undefined,
): DiscoverableTool[] {
	return partitionSkillsForPrompt(skills, settings, true).discoverable.map(skill => ({
		name: discoverableSkillEntryName(skill.name),
		label: skill.name,
		summary: skill.description,
		source: "skill",
		schemaKeys: [],
		searchText: skill.searchText,
	}));
}

export interface BuiltSkillPromptMessage {
	message: string;
	details: SkillPromptDetails;
}

export function getSkillSlashCommandName(skill: Pick<Skill, "name">): string {
	return `skill:${skill.name}`;
}

/**
 * Parsed `/skill:<name>` invocation: either at the start of the draft (the
 * traditional slash-command position) or as a `/skill:<name>` token embedded
 * mid-prompt. For the mid-prompt form the surrounding prose is threaded
 * through as `args` so the skill sees the full user request.
 */
export interface ParsedSkillInvocation {
	/** Bare skill name without the leading `skill:` prefix. */
	name: string;
	/** User-supplied arguments (everything outside the `/skill:<name>` token). */
	args: string;
}

const MID_PROMPT_SKILL_RE = /(^|\s)\/skill:([^\s/]+)(\s|$)/;

/**
 * Detect a `/skill:<name>` invocation in a user draft.
 *
 * Returns `undefined` when the text contains no skill token. Otherwise:
 *   - Leading form (`/skill:foo bar baz`): name=`foo`, args=`bar baz`.
 *   - Mid-prompt form (`fix the bug /skill:foo focus on auth`): name=`foo`,
 *     args=`fix the bug focus on auth` — the surrounding prose collapsed
 *     into a single args string.
 *
 * Mid-prompt detection is disabled when the draft itself starts with a
 * different slash command (e.g. `/compact /skill:foo`) or a local-execution
 * sigil — `!cmd` / `!!cmd` for the bash tool and `$ cmd` / `$$ cmd` for the
 * python tool. Those handlers run after the skill-command dispatcher and
 * their bodies routinely contain `/skill:<name>` references that are not
 * meant as skill invocations.
 */
export function parseSkillInvocation(text: string): ParsedSkillInvocation | undefined {
	const trimmedStart = text.trimStart();
	if (trimmedStart.startsWith("/skill:")) {
		const spaceIndex = trimmedStart.indexOf(" ");
		const name =
			spaceIndex === -1 ? trimmedStart.slice("/skill:".length) : trimmedStart.slice("/skill:".length, spaceIndex);
		if (!name) return undefined;
		const args = spaceIndex === -1 ? "" : trimmedStart.slice(spaceIndex + 1).trim();
		return { name, args };
	}
	if (trimmedStart.startsWith("/")) return undefined;
	if (startsWithLocalExecutionPrefix(trimmedStart)) return undefined;
	const match = MID_PROMPT_SKILL_RE.exec(text);
	if (!match) return undefined;
	const leading = match[1] ?? "";
	const trailing = match[3] ?? "";
	const tokenStart = match.index + leading.length;
	const tokenEnd = match.index + match[0].length - trailing.length;
	const name = match[2] ?? "";
	if (!name) return undefined;
	const before = text.slice(0, tokenStart).trimEnd();
	const after = text.slice(tokenEnd).trimStart();
	const args = [before, after]
		.filter(part => part.length > 0)
		.join(" ")
		.trim();
	return { name, args };
}

/**
 * Whether the (already left-trimmed) draft begins with a TUI local-execution
 * sigil that downstream branches will consume verbatim — `!`/`!!` for the bash
 * tool and `$`/`$$` followed by ASCII whitespace for the python tool. Mirrors
 * `pythonCommandPrefixLength` in `modes/controllers/input-controller` so the
 * two checks agree without forcing a circular import.
 */
function startsWithLocalExecutionPrefix(trimmedStart: string): boolean {
	if (trimmedStart.startsWith("!")) return true;
	if (trimmedStart.charCodeAt(0) !== 36 /* $ */) return false;
	if (trimmedStart.charCodeAt(1) === 123 /* { */) return false;
	const sigilLength = trimmedStart.charCodeAt(1) === 36 /* $ */ ? 2 : 1;
	const next = trimmedStart.charCodeAt(sigilLength);
	if (Number.isNaN(next)) return true;
	return next === 32 /* space */ || next === 9 /* tab */ || next === 10 /* LF */ || next === 13 /* CR */;
}

export type SkillInvocationKind = "user" | "autoload";

export async function buildSkillPromptMessage(
	skill: Pick<Skill, "name" | "filePath" | "baseDir">,
	args: string,
	invocation: SkillInvocationKind = "user",
): Promise<BuiltSkillPromptMessage> {
	const content = await Bun.file(skill.filePath).text();
	const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
	const trimmedArgs = args.trim();
	let message: string;
	if (invocation === "user") {
		// User-invoked skills announce themselves and expose their skill directory
		// so the model resolves the skill's own relative paths (scripts/, templates/).
		message = prompt
			.render(userInvocationTemplate, {
				name: skill.name,
				body,
				baseDir: skill.baseDir,
				userArgs: trimmedArgs || undefined,
			})
			.trim();
	} else {
		// Autoload skills are hidden, non-user context — they MUST NOT claim the
		// user invoked them; this keeps the minimal provenance-only format.
		message = prompt
			.render(autoloadTemplate, {
				body,
				filePath: skill.filePath,
				userArgs: trimmedArgs || undefined,
			})
			.trim();
	}
	return {
		message,
		details: {
			name: skill.name,
			path: skill.filePath,
			args: trimmedArgs || undefined,
			lineCount: body ? body.split("\n").length : 0,
		},
	};
}
