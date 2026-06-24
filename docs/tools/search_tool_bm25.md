# search_tool_bm25

> Search the hidden tool-discovery index, activate the top tool matches for the current session, and surface discovery-hidden skills as `skill://<name>` reads.

## Source
- Entry: `packages/coding-agent/src/tools/search-tool-bm25.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/search-tool-bm25.md`
- Key collaborators:
  - `packages/coding-agent/src/tool-discovery/tool-index.ts` — discoverable-tool metadata and BM25 index/search.
  - `packages/coding-agent/src/session/agent-session.ts` — session discovery mode, corpus assembly, activation, cache invalidation.
  - `packages/coding-agent/src/sdk.ts` — initial hiding of discoverable built-ins and prompt-time discoverable summary.
  - `packages/coding-agent/src/tools/index.ts` — tool-session discovery hooks, essential/discoverable load modes, registry wiring.
  - `packages/coding-agent/src/config/settings-schema.ts` — `tools.discoveryMode`, `skills.discoveryMode`/`skills.pinnedSkills`, and legacy `mcp.discoveryMode` settings.
  - `packages/coding-agent/src/extensibility/skills.ts` — `partitionSkillsForPrompt()` / `collectDiscoverableSkillEntries()` map unpinned skills into the corpus.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Natural-language or keyword query. Trimmed before search; empty-after-trim is rejected. |
| `limit` | `integer` | No | Max matches to return and activate. Minimum `1`. Defaults to `8` (`DEFAULT_LIMIT`). |

## Outputs
- Single-shot `AgentToolResult`.
- Model-visible `content` is one text part containing JSON with:

```json
{"query":"...","activated_tools":["..."],"skills":[{"name":"...","description":"...","read":"skill://..."}],"match_count":2,"total_tools":17}
```

- `skills` is omitted when no skill entries matched.

- Runtime-only `details` carries the ranked matches used by the TUI renderer:
  - `query`, `limit`, `total_tools`
  - `activated_tools`: tool names activated by this call
  - `active_selected_tools`: cumulative discovered-tool selections still active
  - `tools`: array of match objects with
    - `name`
    - `label`
    - `description` (`tool.summary`; this is the only snippet-like field)
    - optional `server_name`
    - optional `mcp_tool_name`
    - `schema_keys`
    - optional `skill_uri` (`skill://<name>`, set for skill-source matches)
    - `score` rounded to 6 decimals
- The renderer shows a status line plus up to 5 collapsed tree items by default (`COLLAPSED_MATCH_LIMIT`), each with label, optional server name, score to 3 decimals, and truncated description. The ranked match list is not serialized into `content`.

## Flow
1. `SearchToolBm25Tool.createIf()` in `packages/coding-agent/src/tools/search-tool-bm25.ts` exposes the tool for explicit discovery modes (`"mcp-only"` / `"all"`), legacy `mcp.discoveryMode === true`, or `skills.discoveryMode === "search"`. The default `"auto"` mode is resolved later by `createAgentSession()` after MCP/extension tools are registered.
2. `description` is rendered from `packages/coding-agent/src/prompts/tools/search-tool-bm25.md` via `renderSearchToolBm25Description()`, using the current discoverable-tool list plus per-server summary/count.
3. `execute()` re-checks capability and settings:
   - missing discovery hooks -> `ToolError("Tool discovery is unavailable in this session.")`
   - discovery disabled and no skill entries in the corpus -> `ToolError("Tool discovery is disabled. Enable tools.discoveryMode, mcp.discoveryMode, or skills.discoveryMode to use search_tool_bm25.")`
4. `query` is trimmed and validated; `limit` is defaulted/validated.
5. `getDiscoverableToolSearchIndexForExecution()` fetches the cached generic search index from the session when available, otherwise rebuilds an index from the current discoverable-tool list.
6. `getSelectedToolNames()` reads the current discovered selections so already-selected tools can be excluded from fresh results.
7. `searchDiscoverableTools()` in `packages/coding-agent/src/tool-discovery/tool-index.ts` tokenizes the query, scores every document with BM25, sorts by descending score then `tool.name`, and returns up to `searchIndex.documents.length` results; `execute()` then filters already-selected names and slices to `limit`.
8. If any non-skill matches remain, `activateTools()` activates them through `session.activateDiscoveredTools()` or legacy `activateDiscoveredMCPTools()`. Skill matches are never activated: they surface in `content` as `{name, description, read}` entries whose `read` is a `skill://<name>` URI the model reads directly.
9. `details` is assembled from the activated names, current selected names, corpus size, and formatted matches; `content` is reduced to the compact JSON summary from `buildSearchToolBm25Content()`.
10. `searchToolBm25Renderer` renders either:
   - the structured `details` view, or
   - a fallback text-only warning block if `details` is absent.

## Modes / Variants
- Discovery-mode gating:
  - `tools.discoveryMode = "auto"` (default): when the registered tool set has more than 40 tools, searches hidden MCP tools only; otherwise discovery stays off.
  - `tools.discoveryMode = "all"`: searches hidden discoverable built-ins plus hidden MCP tools.
  - `tools.discoveryMode = "mcp-only"`: searches hidden MCP tools only.
  - legacy `mcp.discoveryMode = true`: same as MCP-only.
  - `skills.discoveryMode = "search"`: unpinned skills (not matching `skills.pinnedSkills` globs) leave the system prompt `<skills>` listing — replaced by a `<skills-discovery>` roster line — and join the corpus as `source: "skill"` entries named `skill:<name>`. This keeps `search_tool_bm25` alive even when tool discovery resolves to off. Frontmatter-hidden skills (`hide: true` / `disable-model-invocation: true`) stay out of both the listing and the corpus. Pins are editable as comma-separated globs in the Settings panel (tools tab) or per skill with `ctrl+p` in the Extension Control Center (`/extensions`), which toggles literal names and badges pinned rows. The settings input suggests the closest skill names from the discovered pool while typing (↑/↓ choose, Tab accepts; glob segments preview their matches) and shows a live `matches N of M skills` count.
- Search-index source:
  - generic cached discoverable index from the session (`getDiscoverableToolSearchIndex()`)
  - rebuilt ad hoc from the current discoverable-tool list when the cache path fails
- Activation backend:
  - generic `activateDiscoveredTools()`
  - legacy `activateDiscoveredMCPTools()` fallback

## Side Effects
- Session state
  - Adds matched non-skill tools to the active session tool set through `activateDiscoveredTools()` / `activateDiscoveredMCPTools()`. Skill matches mutate nothing: the model follows the returned `skill://` URI with `read`.
  - Updates discovered-tool selection state so repeated searches accumulate selections instead of replacing them.
  - Invalidates the cached discoverable search index when newly activated built-ins change the hidden corpus (`packages/coding-agent/src/session/agent-session.ts`).
  - Tool availability changes before the next model call in the same turn; the prompt text says this explicitly.
- User-visible prompts / interactive UI
  - The tool description includes discoverable server summaries, total discoverable-tool count, and (in skill search mode) the discoverable-skill count.
  - The TUI renderer shows ranked matches, but the model-visible text summary does not.

## Limits & Caps
- Default result cap: `8` (`DEFAULT_LIMIT` in `packages/coding-agent/src/tools/search-tool-bm25.ts`).
- `limit` must be a positive integer; no tool-level upper bound beyond corpus size.
- Renderer collapsed list cap: `5` (`COLLAPSED_MATCH_LIMIT`).
- Renderer truncation widths:
  - label: `72` chars (`MATCH_LABEL_LEN`)
  - description: `96` chars (`MATCH_DESCRIPTION_LEN`)
- BM25+ parameters in `packages/coding-agent/src/tool-discovery/tool-index.ts`:
  - `BM25_K1 = 1.2`
  - `BM25_B = 0.75`
  - `BM25_DELTA = 1.0`
- Weighted corpus fields (`FIELD_WEIGHTS`):
  - `name`: `6`
  - `label`: `4`
  - `mcpToolName`: `4`
  - `serverName`: `2`
  - `summary`: `2`
  - each `schemaKey`: `1`
  - `searchText`: `1` (index-only extra text; skills use a capped SKILL.md body excerpt)
- Summary fallback length for discoverable metadata: first `200` chars of `description` when no explicit summary exists (`getDiscoverableTool()` in `packages/coding-agent/src/tool-discovery/tool-index.ts`).

## Errors
- `execute()` throws `ToolError` for unavailable discovery hooks, disabled discovery mode, empty trimmed query, and non-positive/non-integer `limit`.
- `searchDiscoverableTools()` throws `Error("Query must contain at least one letter or number.")` if tokenization produces no letter/number tokens; `execute()` catches `Error` and rethrows `ToolError(error.message)`.
- Empty corpus is not an error; search returns `[]`, activation is skipped, and the renderer message becomes either `No discoverable tools are currently loaded.` or `No matching tools found.`
- `getDiscoverableToolsForDescription()` and `getDiscoverableToolSearchIndexForExecution()` swallow discovery-hook/cache errors and fall back to an empty corpus or rebuilt index.

## Notes
- The tool wire name stays `search_tool_bm25` for persisted-session back-compat, even though the source file is `search-tool-bm25.ts`.
- Corpus composition is session-dependent and excludes already-active tools:
  - MCP entries come from `#discoverableMCPTools` (built by `#collectDiscoverableMCPToolsFromRegistry()`), filtered to names not currently active; `MCPTool` carries no `summary`, so `getDiscoverableTool()` derives `summary` from the first `200` chars of `description`.
  - Built-in entries appear only in `"all"` mode and only for registry tools whose `loadMode === "discoverable"` and are not currently active.
  - Skill entries (`source: "skill"`, name `skill:<name>`, summary = skill description, no schema keys) appear whenever `skills.discoveryMode === "search"`, regardless of the tool discovery mode. Each carries a `searchText` body excerpt (first `2000` chars of SKILL.md, `SKILL_SEARCH_TEXT_LIMIT` in `packages/coding-agent/src/extensibility/skills.ts`) indexed at weight 1 for paraphrase recall; it is never displayed. Skills disabled via `/extensions` (`disabledExtensions` `skill:` ids), `ignoredSkills`, or `includeSkills` are filtered inside `loadSkills()` before partitioning, so they never reach the corpus.
  - Hidden/internal built-ins are intentionally excluded from the built-in corpus: `resolve`, `yield`, `report_finding`, `report_tool_issue` are called out in the `#collectDiscoverableBuiltinTools()` comment.
- `DiscoverableToolSource` includes `"extension"` and `"custom"`, but `AgentSession.getDiscoverableTools()` currently assembles built-in, MCP, and skill sources.
- On startup, `packages/coding-agent/src/sdk.ts` resolves `"auto"` after the full registry exists and injects `search_tool_bm25` when the count exceeds 40. It hides non-essential discoverable built-ins only in `tools.discoveryMode = "all"`. Tools whose class is marked as `loadMode === "essential"` (defaults are `read`, `bash`, `edit`, `write`, `find`, and `eval`) are always active; they survive hiding regardless of configuration. `tools.essentialOverride` can be used to treat additional discoverable tools as essential (active on startup) or to explicitly specify the active essential list.
- Query tokenization is simple and deterministic: Unicode is NFKD-normalized, combining marks are dropped, acronym/camelCase and digit-to-capital boundaries are split, non-letter/non-number characters become spaces, tokens are lowercased, and only non-empty tokens survive.
- Scores are rounded differently by surface: `details.tools[].score` keeps 6 decimals; the TUI line renders 3.
