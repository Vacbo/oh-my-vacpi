# search_skills

> Find a loaded-but-unlisted skill by describing the capability you need.

## Source
- Entry: `packages/coding-agent/src/tools/search-skills.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/search-skills.md`
- Ranker: `packages/coding-agent/src/extensibility/skill-search.ts`
- Corpus / partitioning: `packages/coding-agent/src/extensibility/skills.ts`

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "essential"`. It stays top-level rather than mounting under `xd://` — a tool the model had to discover first could not be the entry point to discovery.
- `SearchSkillsTool.createIf(session)` registers it only when `skills.discoveryMode = "search"` (default `"all"`). With the default, every visible skill is already listed in the system prompt and the tool would have nothing to find.
- Execution is single-shot and emits no progress updates.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `query` | `string` | Yes | Natural-language or keyword description of the capability. |
| `limit` | `number.integer >= 1` | No | Maximum matches to return. Default `8`. |

## Outputs
- `content[0].text` is JSON: `{ query, skills: [{ name, description, read }], match_count, total_skills }`.
- `read` is the `skill://<name>` URI the model passes to the `read` tool to load the skill's instructions.
- `details = { query, limit, total_skills, skills: [{ name, description, read, score }] }`; `score` keeps 6 decimals, and the TUI line renders 3.
- `total_skills` is the size of the searched corpus (the unlisted skills), not the number of loaded skills.

## Flow
1. `partitionSkillsForPrompt` splits the session's visible skills: names matching a `skills.pinnedSkills` glob stay listed in the system prompt, the rest become the search corpus. Frontmatter-hidden skills (`hide: true` / `disable-model-invocation: true`) land in neither and stay reachable only through `/skill:<name>` and `skill://<name>`.
2. `collectDiscoverableSkillEntries` maps the unlisted skills to `{ name, description, searchText }` entries. `searchText` is the capped SKILL.md body excerpt (2000 chars) that `loadSkills` retains under search discovery — indexed, never rendered.
3. `buildSkillSearchIndex` tokenizes each entry and `searchSkills` ranks the corpus with BM25+ (`k1 = 1.2`, `b = 0.75`, `δ = 1.0`) over three weighted fields: name ×6, description ×2, body excerpt ×1.
4. Ties break on skill name, so identical scores produce a stable order.
5. The top `limit` matches are returned as `skill://` URIs. Nothing is activated.

## Ranking
- Tokenization is deterministic and offline — no embedding provider, no network. Unicode is NFKD-normalized, combining marks are dropped (`café` → `cafe`), acronym/camelCase and digit-to-letter boundaries split (`MCPTool` → `MCP Tool`, `v2Beta` → `v2 Beta`), every non-letter/non-digit becomes a separator, and tokens are lowercased.
- Matching is lexical, not semantic: a query only scores against words that literally appear in the indexed text. Body indexing widens that text, so a query like "robotic phrasing" finds `humanizer` when those words live in the SKILL.md body rather than in its one-line description. A query sharing no words with a skill's name, description, or body will not find it.

## Side Effects
- None. The tool activates no tool, mutates no toolset, writes no session entry, and touches neither filesystem nor network. Repeating a search is free and idempotent.

## Errors
- Empty or whitespace-only `query`: `Query is required and must not be empty.`
- A query with no letter or digit (e.g. `!!!`): `Query must contain at least one letter or number.`
- A non-integer or non-positive `limit`: `Limit must be a positive integer.`
- No unlisted skills in the session: the tool explains that every loaded skill is already listed and points at `skills.discoveryMode`.

## Settings
- `skills.discoveryMode` (`"all" | "search"`, default `"all"`) — `"search"` unlists unpinned skills and registers this tool.
- `skills.pinnedSkills` (globs) — skills that stay listed in the system prompt and therefore never appear in results.

## Notes
- Wire name history: this tool replaced `search_tool_bm25`, which also searched and activated MCP and built-in tools. Tool discovery is now `xd://` device mounting (`tools.xdev`), so the search surface is skills only and no callable alias for the old name exists. Settings arrays holding the old id are rewritten once on config load.
