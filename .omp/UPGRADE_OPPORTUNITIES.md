# Upgrade Opportunities

Running log of vacpi-specific upgrade ideas: prompt bugs, missing features, integration gaps, performance wins. One section per finding. Keep status accurate.

**Status tags**: `[open]` `[in-progress]` `[done]` `[wontfix]` `[deferred]`
**Severity tags**: `[crit]` `[high]` `[med]` `[low]` `[chore]`

---

## 2026-05-25 — eager-todo.md prompt lies about `details` field   `[done]` `[high]`

**Where**: `packages/coding-agent/src/prompts/system/eager-todo.md:8`

**Problem**: The injected system reminder told the model to put implementation specifics in a `details` field. `todo_write` `init`/`append` items have always been `array<string>` — `details` only ever lived on long-removed `add_task`/`update` ops. Every eager-todo session triggered a Zod validation error, the model silently retried without `details`, and the planner phase was wasted compute.

**Bug exists identically on `upstream/main` and `v15.2.4`** — not a vacpi regression.

**Fix shipped**: commit `fe7277c09` rewords line 8 to redirect specifics into a follow-up `note` op and explicitly states the string-only constraint.

**Follow-up**: consider upstreaming the patch to `can1357/oh-my-pi` once verified across a few sessions.

---

## 2026-05-26 — eager-todo.md is prose-only — model still emits `todo_write({})` under forced tool_choice   `[done]` `[high]`

**Where**: `packages/coding-agent/src/prompts/system/eager-todo.md`

**Problem**: Even after `fe7277c09` fixed the `details` hallucination, Opus 4.7 on xhigh reasoning still occasionally fires `todo_write({})` on the very first turn of a brand-new session, fails Zod (`ops: expected array, received undefined`), and burns the eager-todo slot. Trace:
1. Eager-todo prelude injects `tool_choice: { type: "tool", name: "todo_write" }` for Anthropic (`packages/coding-agent/src/utils/tool-choice.ts:11-13`).
2. Anthropic under named-tool forcing MUST emit a `tool_use` block — but may emit it with zero/empty `input` if the model cannot quickly resolve the shape.
3. `parseStreamingJson` (`packages/ai/src/utils/json-parse.ts:132-145`) coerces missing/empty input to `{}`, so an empty emission surfaces verbatim as `{}` at the tool dispatcher.
4. The reminder told the model WHAT to do (init op, single phase, etc.) but never showed the literal JSON shape, so the model had no copy-pasteable anchor to fall back on under forced emission.

**Fix shipped**: embedded a literal example directly in the system reminder:
```
The call MUST match this exact shape (replace the placeholders, keep the `ops` wrapper):
`{"ops":[{"op":"init","list":[{"phase":"<Phase name>","items":["<task 1>","<task 2>"]}]}]}`
```
Plus regression test `anchors the reminder with a copy-pasteable ops-wrapper JSON shape` in `packages/coding-agent/test/agent-session-eager-todo.test.ts` that parses the inlined example through `JSON.parse` and asserts the `op === "init"` + non-empty phase/items, so any future prompt edit that drops the anchor fails CI.

**Why not "auto-recover empty `{}` server-side"**: tempting (synthesize a default todo from the user's text) but adds session-side coupling between tool validation and prompt heuristics. The prompt anchor benefits every forced-tool-choice surface for every model, with zero runtime cost.

**Follow-up**: consider upstreaming to `can1357/oh-my-pi`; the same bug exists there.
---
## 2026-05-25 — Hindsight `recall` / `retain` tools don't surface tag filters   `[open]` `[high]`

**Where**: `packages/coding-agent/src/tools/hindsight-recall.ts:8-10`, `packages/coding-agent/src/tools/hindsight-retain.ts:6-16`

**Problem**: Model-facing schemas are minimal:
- `recall`: `{query: string}` only
- `retain`: `{items: [{content, context?}]}`

The internal `HindsightApi` already supports the full Hindsight feature set per `client.ts:97-104` (`RecallOptions { types, maxTokens, budget, tags, tagsMatch }`) and `MemoryItemInput` accepts tags + metadata + types. Hindsight MCP exposes tag-filtered recall as a first-class feature. We are silently dropping the precision-recall benefit.

**Cost of fix**: ~30 input tokens added to `recall` description, ~20 to `retain`. Two-file Zod schema extension + pass-through to existing client calls. Fully testable.

**Recommended schema (additive, optional)**:
```ts
// recall
{ query: string, tags?: string[], tagsMatch?: "any" | "all" }
// retain.items[]
{ content: string, context?: string, tags?: string[] }
```

**Why not more (types, since/until, budget)**: every added field has prompt cost. Tags give the largest precision improvement per byte. `budget` already auto-resolves from settings; per-call override invites the model to crank it. Time-scoping is rarely useful for a coding agent.

---

## 2026-05-25 — No Hindsight directives sync mechanism   `[open]` `[med]`

**Where**: nothing exists yet

**Problem**: Hindsight supports "directives" (free-form rules that guide future fact extraction — e.g., "always tag architecture decisions as `decision`"). These improve memory *quality*, not memory *quantity*. Vacpi doesn't touch them.

**Recommended approach (non-tool, zero per-turn cost)**:
- Read directives from `~/.omp/agent/hindsight-directives.md` (and/or per-repo `<repo>/.omp/hindsight-directives.md`)
- On settings change / session start, diff against bank directives via `POST .../directives` and `DELETE` — keep bank state in sync with file
- Model never sees a directive tool. UI/file-only.

**Why not a tool**: directive tools would tempt the model to spam directives mid-session. The right surface is "set once, applies to all future retains".

---

## 2026-05-25 — Hindsight MCP "27 tools" trap — do NOT expose   `[wontfix]` `[chore]`

**Where**: `https://docs.hindsight.vectorize.io/mcp/#available-tools`

**Decision**: Do not add Hindsight as an MCP server in vacpi's default config.

**Reasoning**: Hindsight MCP advertises 27 tools in single-bank mode (mental-model CRUD, memory browsing, document mgmt, op polling, bank mgmt). At ~150-300 input tokens of schema per tool, full exposure would add ~5-6K tokens per turn — ~150-180K wasted per session. Most tools are either (a) destructive (clear/delete bank), (b) duplicate auto-handled backend behaviour (mental-model auto-seed), (c) inapplicable (documents, operations polling), or (d) maintenance-class (browse/get individual memories — use the Hindsight UI).

**Power-user escape hatch**: any user who genuinely wants the inventory can `omp mcp add` Hindsight themselves. The vacpi REST client and the MCP server hit the same bank → consistent data. **Document this in `DEVELOPMENT.md`** as the recommended power-user path, then never auto-register Hindsight as MCP in vacpi defaults.

---

## Template for new entries

```markdown
## YYYY-MM-DD — short title   `[status]` `[severity]`

**Where**: `path/to/file.ts:line` or `link`

**Problem**: one-paragraph factual statement of what's wrong and what the cost is.

**Fix / Recommended approach**: concrete plan; mention token/perf cost vs benefit.

**Why not <alternative>**: optional, when the obvious approach is wrong.
```

---

## 2026-05-26 — Subagent / recursive tool-call rendering is flat-text   `[open]` `[med]`

**Where**: subagent `task` panel inline view; Session Observer (`Ctrl+S`); tool-call collapsed view (`Ctrl+O` to expand)

**Problem**: When a subagent is dispatched via the `task` tool, the parent session renders the spawned task as a minimal one-line entry under a `Tasks` heading, and the full subagent prompt + tool stream is reachable only via Session Observer (`Ctrl+S`). Both surfaces drop visual hierarchy and color information:

- **Subagent prompt body** renders as monochrome plain text. Markdown headings (`##`), fenced code blocks, inline code, bullet lists — all flattened. The user-supplied context that authored the dispatch (often Markdown-formatted) loses its structure on display, making it bloated and hard to scan.
- **Tool-call output inside the subagent view** is also flat. There's no per-tool renderer (no syntax highlighting on code reads, no colored diff rendering on edits, no inline `+`/`-` for patches, no truncated-with-anchor previews for grep hits). Compare to the parent session's main view which has per-tool theming.
- **Session Observer** (Ctrl+S) has solid primitives: vim-style `j/k` scroll, `Enter` to expand a tool call, `[`/`]` to cycle agents, `g/G` to jump, tree-like nesting. But it inherits the same flat renderer — code blocks, diffs, file paths all look identical in the same muted color.
- **Tool-call default collapse** (need `Ctrl+O` per tool to see full output) is the right default for short interactions, but during deep subagent runs (50+ tool calls) it's tedious. There's no setting to toggle "always-expanded" globally or per-tool-type.

**Cost of the current behavior**: long subagent prompts and outputs become text-walls in the user's terminal. The user has to constantly Ctrl+O to inspect, or open Session Observer and scroll through monochrome output. Reading subagent reasoning chains is slower than reading the parent session.

**Recommended approach**:

1. **Reuse the parent-session tool-call renderers in subagent inline view AND Session Observer**. The render path for tool calls is already abstracted per-tool (see `packages/coding-agent/src/tools/*/render.ts` and `packages/coding-agent/src/modes/components/tool-execution.ts`). Pass them through unchanged when nested under a `Tasks` parent. Token cost: zero (renderers already exist). Implementation cost: refactor the panel composition to delegate to the same renderer registry.

2. **Markdown-render the subagent prompt body**. The parent session already markdown-renders agent messages (`packages/coding-agent/src/modes/components/transcript/markdown-renderer.ts` or similar). Reuse it for the task-dispatch context/assignment fields.

3. **Add a setting `tools.alwaysExpand` (default: false)** that, when true, skips the collapsed preview and renders full output by default. Per-tool overrides via `tools.alwaysExpand.bash`, `tools.alwaysExpand.read` etc. Useful for power users running long subagent chains.

4. **Color-aware diff rendering in Session Observer**. The `edit` and `ast_edit` tools already produce diff-shaped output (`+`/`-` prefixes with hashlines). The Observer renderer should call into the same diff colorizer the parent session uses (theme keys `diff.add`, `diff.remove`, `diff.context` already exist).

**Why not "just open another omp instance for the subtask"**: that costs a new process, new context bootstrap (cache loads, plugin discovery, model registry hydrate), new session row, and breaks the parent-task observability chain (parent can't tail the child's output or cancel cleanly). The subagent mechanism is correct architecturally; the renderer is the gap.

**Why not "auto-expand all tool calls"**: would explode the parent-session scrollback during normal interactive use. The opt-in setting is correct.

**Tasteful-rendering note**: the user explicitly called out that the flat monochrome look conflicts with vacpi's broader UI taste (poimandres themes, careful symbol choices, thoughtful tool-call animations). The Observer view is functionally usable but visually orphaned from the rest of the TUI. A rendering pass that lands all three of (1)+(2)+(4) would close the gap.

**Follow-up**: prototype (1) first since it has the highest visual impact and reuses existing code. (4) is a small wrapper. (2) and (3) can land later.

---

## 2026-05-26 — Upstream OG-repo PRs worth merging into vacpi   `[open]` `[chore]`

**Where**: `https://github.com/can1357/oh-my-pi/pulls?state=open`. PR number is the identity for each pick below. Quality bar: real RCA, focused scope, tests included, not stuck in DRAFT, not superseded by a sibling, not "feat(ai): yet another provider". The `Files (100)` cosmetic count from the PR API reflects branch-vs-`main` drift, not actual PR scope — every shortlist entry was vetted against the body's own files-changed table.

### Tier A — CLEAN merge state, focused scope, tested

- **#1389** `[high]` `lsp/edits.ts` — accept `$`-prefixed identifiers (`$store`, RxJS, Svelte signals) + apply `documentChanges` in declared order per LSP §3.16.2 (create→edit ordering, folder rename/delete subtree flush); 4 files, 24-case regression suite
- **#1388** `[med]` bundled review fixes for `browser/patch/mcp/find/DAP` — each independently small (`tab-supervisor` `networkidle2`→`load`, post-write `ToolError` path leak, `mcp://` selector opaqueness, `find` timeout/order/escaped-comma, DAP launch error preference, debugpy `pip install` hint); 10 files
- **#1378** `[high]` restore per-tool approval policies as `tools.approvalMode: auto|prompt|custom` with `--auto-approve` flag, `ACTION_EXCEPTIONS`, extended critical-bash patterns (`chmod -R 777 /`, `bash <(curl …)`, `nc -e`); supersedes #1037, closes #1030; 14 files, 64 tests
- **#1365** `[med]` `tui/tui.ts` stops emitting `CSI 3 J` on resize/shrink/offscreen-mutation paths so terminal scrollback survives redraws; adds viewport-refresh path
- **#1328** `[med]` `hashline/parser.ts` normalizes `ANCHOR-ANCHOR` (the dash range emitted by `read` collapsed output) to `ANCHOR..ANCHOR` before parsing; insert ops still reject ranges; 3 files
- **#1308** `[med]` Rust + TS pre-pass that flips unquoted `[A-Za-z]:\…` tokens to forward slashes before brush so Windows drive paths stop being eaten; quoted paths preserved; 8 files, 72 tests
- **#1159** `[high]` root-causes `Bun.write(dest, Response)` hanging on Windows .exe writes through Defender → buffer via `response.bytes()`; bonus: collapses yt-dlp pipeline 4→1 call (2.74× faster) and surfaces first-run install banner; 4 files

### Tier B — UNKNOWN/DIRTY merge state but excellent RCA + tests

- **#1279** `[high]` CWE-79 in OAuth callback (`</script>` in `error_description` escapes the JSON state block on `http://localhost:54545` etc.); JSON `\u003c` escape + `replaceAll(() => …)`; 12 lines + regression
- **#1264** `[high]` single Handlebars `{{#if systemPromptCustomization}}` block restored to default `system-prompt.md` — `.claude/SYSTEM.md`, `.gemini/system.md`, etc. have been silently dropped since the `7b17024` rewrite
- **#1325** `[high]` vendored `brush_core::interp::setup_open_file_with_contents` no longer deadlocks on heredocs >4 KiB Windows / >64 KiB macOS; falls through to a detached writer thread off the Linux `F_SETPIPE_SZ` fast path; cross-platform regression
- **#1214** `[high]` content-verified hashline rebase using `FileReadCache` snapshot — addresses Codex P1 hash-collision review (2-char hashes over 647 buckets); 15-case eval (11/15 applied, 15/15 correct, 4/4 safety holds)
- **#1163** `[high]` `transformMessages` pulls a later `tool_result` forward when two assistant turns interleave before the batched user-side results land, fixing the recurrent Anthropic `400 tool_use ids ... without tool_result` mid-session
- **#1366** `[high]` `AgentSession.#checkCompaction()` runs threshold compaction *before* promotion attempt; drops bogus `contextPromotionTarget` links where catalog candidate is not strictly larger; surfaces `model_change.reason`. Supersedes #1332
- **#1304** `[med]` Claude Code 2.1.148 wire-format parity — XXHash64 `cch=` from in-place body patching, 3-block system layout, prompt-cache breakpoint reorder, OAuth scopes + `oauth-2025-04-20` beta on refresh; reverse-engineered against live proxy. Supersedes #962
- **#1342** `[med]` OpenAI Responses first-party hosted tools (`web_search`, `computer`, `file_search`, `code_interpreter`, MCP) wired through `auth-gateway` + agent passthrough + `coding-agent` settings; 19 files, tests
- **#1310** `[med]` TUI text selection — Ctrl+A, Shift+Arrow, Ctrl+Home/End, Ctrl+C copy via native `arboard`; layout-aware ANSI reverse-video; cursor adjustments for the inserted bytes; 3 files
- **#1098** `[high]` Cursor MAX mode (`:max` suffix unlocks 1M context on 5.x), persists across resume + subagent inheritance, new `SegmentedMessageBuilder` for tool-call interleaving + Cursor cumulative token reconciliation; 49 files, broad test coverage
- **#1198** `[med]` propagate ACP permission delegate into delegated subagent sessions + reorder `tool_execution_start` to fire *after* `beforeToolCall`, so permission gates can request approval before the running card renders; 10 files
- **#831** `[med]` `MCPManager.setCwd()` broadcasts `notifications/roots/list_changed`; client declares `roots.listChanged: true`; shared `buildRootsList(cwd)`; macOS `/private/...` normalization via `normalizeProjectPath`; 17 tests
- **#896** `[high]` `assistantMessageEndsWithQuestion` predicate gates auto-continue + todo reminders when assistant ends turn with a question (real captured session repro)
- **#1028** `[high]` macOS alerter-based desktop notifications with tmux click-jump; concrete RCA on OSC permission failure + foreground-suppression inversion; 52 tests

### Tier C — niche but tight + tests

- **#1319** `[low]` Ctrl+O (`app.tools.expand`) moved from editor-scoped handler to global input listener, matching the existing debug key pattern
- **#1318** `[low]` `--hide-thinking` CLI flag (display-only — does not disable reasoning, just suppresses the block in the TUI)
- **#1311** `[med]` ACP execute tool cards surface `$ <command>` as `tool_call.title`/`content` for `bash`/`shell`/`exec`; `eval` cell source included; replay-aware; 2 files
- **#1307** `[med]` Claude slash command subdirectory namespacing — `recursive: true` + relative-path-to-`:`-derived name (`.claude/commands/<ns>/<cmd>.md` → `/<ns>:<cmd>`); 1 file
- **#1305** `[low]` `/model` skips re-prompting the thinking level when re-selecting the existing default model
- **#820** `[low]` clear `this.#pendingModelSwitch` immediately in `#exitPlanMode`; 1-line fix + 131-line regression test
- **#1374** `[med]` `/review` custom-instructions submit (Enter submits, Shift+Enter inserts newline) + paste-marker expansion before hook submit; static prompt templates extracted
- **#1368** `[med]` `resolveManifestEntries` expands `pi.extensions: ["./extensions"]` directories with nested `<name>/index.ts` entries; mirrors `discoverExtensionsInDir` so manifest contract matches auto-discovery; closes #1292
- **#1371** `[med]` split host-safe defaults from RPC-only defaults so ACP preserves `async.*` / `bash.autoBackground.*` opt-ins; closes #1324
- **#1200** `[med]` `loadFilesFromDir` no longer recurses `.claude/tools/` (also forwards `recursive` option to native glob + adds `extensions` filter)
- **#1201** `[med]` Codex web search default falls through `gpt-5.4` and retries the next candidate on `model not supported when using Codex with a ChatGPT account`
- **#1196** + **#1195** + **#1194** `[low]` debug-tool batch — debugpy install hint surfaced from adapter stderr, reject directory `program` targets (preserving Delve `program: "."`), prefer primary launch errors over `configurationDone` failure; refs #1187
- **#1210** `[high]` `Copilot-Integration-Id: vscode-chat` header + stable accountId dedup via `GET /user` so `/login` stops appending a row per attempt; fixes intermittent `400 model_not_available_for_integrator` from `ghu_` tokens
- **#1211** `[med]` `dynamicIsAuthoritative: true` + `filterModel` so org-policy-blocked Copilot models (omitted from `/models` response) stop appearing in the picker; prunes 13 stale bundled entries on this account
- **#1312** `[med]` `buildGrpcRequest` uses `findLastUserMessageIndex` so Cursor stops emitting `Cannot send empty user message to Cursor API` when context ends with a tool result; 2-line fix + 75-line test
- **#1183** `[med]` ZIP central-directory name decoding (UTF-8 flag → Info-ZIP `0x7075` extra → CP437) + payload CRC validation; fixes mojibake on legacy archives; ZIP64 sentinels rejected cleanly
- **#1272** `[low]` Kagi V1 web-search API (V0 is being sunset); new client, provider, settings, 328-line test file
- **#1127** `[med]` xAI Grok OAuth with clean separation (no xAI strings in OpenAI Responses path); new generic `includeEncryptedReasoning` / `filterReasoningHistory` / `headers` / `extraBody` flags on `OpenAIResponsesOptions`; 12 themed commits
- **#1172** `[low]` `LITELLM_BASE_URL`/`LITELLM_API_KEY`/`VLLM_BASE_URL`/`VLLM_API_KEY` env-var fallbacks at the model-manager level; also brings LM Studio into line
- **#972** `[med]` DeepSeek V4 reasoning_content alias forcing on ZenMux/NIM/DeepInfra — `isDeepseekFamily` provider-aware compat detection + canonical-field forcing in Tier 1 recovery
- **#954** `[med]` MiniMax merges multiple `system` messages into one with `\n\n` separator + removes incorrect `thinkingFormat: "zai"`; live-API verified against the 400 error 2013 (`api.minimax.io/v1`)
- **#807** `[low]` generalize OpenCode reasoning placeholder rule to Zen + Go endpoints; updates `convertMessages` comments
- **#1164** `[chore]` README surfaces the `goal` hidden tool + the 75 `read`-scrapers count (was understated as three); 1-file docs change
- **#1139** `[med]` custom `SYSTEM.md`/`APPEND_SYSTEM.md` rendered through the native Handlebars data model (new `appendSystemPromptTemplate` option); internal memory/MCP append stays raw
- **#950** `[med]` WSL `xdg-open` rewritten to `wslview <wslpath -w>` so `/mnt/d/...` HTML exports open in the host browser
- **#803** `[low]` session observer list sorted newest-first (1-line safe UX)

### Already-rejected (do not re-evaluate)

- **#1037** superseded by #1378 (per-tool approval, original luzidd version)
- **#1332** superseded by #1366 (threshold compaction)
- **#962** superseded by #1304 (Claude Code wire-format parity)
- **#981** Effort.Max — already implemented locally
- **#1175** overlaps #1214; aggressive recovery refactor without #1214's content-verification safety
- **#834** behavior-preserving refactor, blocked by upstream main
- **#1242, #1212** stale 100-file branch drift; the original fix would be trivial to re-author
- **#800** vague description, no RCA
- **#1390, #1387, #1360, #984** provider drop-ins with no broader value
- **#1381** WIP memory taxonomy, 40-file surface area
- **#1019, #1009, #806, #805, #804, #802** lack tests or have thin descriptions
- **#1255** Spanish-language doc clarification (upstream-only relevance)

**Status policy**: keep `[open]` until cherry-picked into vacpi. Update to `[done]` with the merge SHA after the local cherry-pick lands. Tier-A picks should clear first (lowest review cost, highest local benefit).
---

## 2026-05-26 — Service tier (Codex priority / fast variant) is hidden behind `/fast` and settings  `[open]` `[med]`

**Where**:
- Slash command: `packages/coding-agent/src/slash-commands/builtin-registry.ts:163-229` (`/fast on|off|toggle|status`)
- Setting: `packages/coding-agent/src/config/settings-schema.ts:785-817` (`serviceTier`, default `"none"`)
- Wire-level realization: `packages/ai/src/providers/openai-codex-responses.ts:592-596` (sets `service_tier` only when resolved to `flex|scale|priority`)
- Status indicator: `packages/coding-agent/src/session/agent-session.ts:5160-5173` (`isFastModeActive()` lights up the ⚡ glyph)
- Premium accounting: counted in `usage.premiumRequests` (`packages/ai/CHANGELOG.md:270`) so `/usage` and `omp stats` show the cost

**User report**: "I can't set the priority of the service tier for ChatGPT 5.5 with the Codex subscription — I want to choose whether to use the fast variant (~50% extra cost) or not."

**Reality**: the capability already exists end-to-end. The user can already do all three:

1. `/fast on` — sets `serviceTier: "priority"` for the active session. Realized as `service_tier: "priority"` on `openai-codex-responses` requests and increments `premiumRequests` by 1 per call (matches the GitHub Copilot premium-budget semantics).
2. Settings UI → **Model** tab → **Service Tier** → `Priority` (or scoped `Priority (OpenAI only)` so a mid-session switch to a Claude model doesn't quietly turn on Anthropic fast mode too).
3. `~/.omp/settings.json` → `"serviceTier": "openai-only"` for sticky-across-sessions opt-in scoped to the OpenAI / OpenAI-Codex providers.

**Upstream PRs already merged covering this** (no work to backport):
- [`can1357/oh-my-pi#1171`](https://github.com/can1357/oh-my-pi/pull/1171) — adds the `/fast` toggle, Anthropic `speed: "fast"` realization with auto-fallback, scoped tier values (`openai-only`, `claude-only`), and routes everything through `resolveServiceTier(tier, provider)`.
- Earlier release notes in `packages/ai/CHANGELOG.md:75-80, 270, 971` document the OpenAI Codex side: `service_tier` SSE payload fix, priority-as-premium-request counting, and the `ServiceTier` type itself.
- A scan of currently open upstream PRs (as of 2026-05-26) shows nothing further on service tier — the feature is considered done upstream.

**So the actual gap is discoverability, not implementation.** Two cheap wins:

1. **Status-line affordance for "tier is OFF"**: today only the ON state has a glyph (⚡). A muted-color hint when the user opens the model selector ("Fast: off — `/fast on` for priority @ 1 premium request/turn") would make the toggle visible at the exact moment users think about it. Cost: a single line in `ModelSelectorComponent`. No new prompt tokens.
2. **Codex-subscription onboarding note**: a one-liner in `DEVELOPMENT.md` (or the in-TUI `/help`) explicitly tying `/fast` to "Codex priority / fast variant" using the user's own vocabulary. Today the `/fast` description says "OpenAI service_tier=priority, Anthropic speed=fast" — accurate but jargon-heavy.

**Why not "add a new dedicated `/codex-priority` command"**: would fragment the existing well-designed scoped-tier surface (`/fast on` already routes through `resolveServiceTier` and respects `openai-only` scope). The right move is to surface the existing toggle, not duplicate it.

**Why not "per-model service tier override"**: tempting, but `serviceTier` is already a session-level setting that resolves per-provider via `resolveServiceTier`. A per-model override would multiply config surface for a knob users rarely tune more than twice per session. The scoped values (`openai-only`, `claude-only`) already handle the "I want priority on Codex but not when I swap to Claude" case.

**Follow-up**: discoverability fix only. No code changes needed for the underlying capability.

---

## 2026-05-26 — Slash command picker has no frecency / usage ranking   `[open]` `[med]`

**Where**: `packages/tui/src/autocomplete.ts:264-300` (`CombinedAutocompleteProvider`'s slash-command branch)

**Problem**: When the user types `/` and starts a query, slash commands are ranked purely by static fuzzy match quality:

```ts
.sort((a, b) => b.score - a.score)
```

where `score = max(fuzzyScore(name), fuzzyScore(desc) * 0.5)`. No record of which commands the user actually picks. So if the user picks `/exit` ten times a session, `/e` still returns the same order as a brand-new install. Power users running the same handful of slash commands repeatedly get no acceleration from doing so.

This is independent of FFF. FFF (`pi-fff`) intentionally only handles `@`-prefixed file mentions (`pi-fff/src/index.ts:424`), so slash commands fall through to the base provider unchanged. FFF wouldn't fix this even if it tried — commands aren't files, they're not in FFF's index.

**Recommended approach**:

1. Add a `slashCommandUsage: Record<string, { count: number; lastUsedAt: number }>` field to the settings storage (mirror the existing `modelUsage` shape from `packages/coding-agent/src/config/settings-storage.ts`).
2. Add `recordSlashCommandUsage(name: string)` to storage. Call it from the command-execution callsite once `input-controller.ts` resolves a slash command to its handler.
3. Pass the usage map into `CombinedAutocompleteProvider` via the existing `AutocompleteRequestOptions` (already plumbed through `getSuggestions`). The provider blends a recency-decayed boost into the score:

   ```ts
   const boost = usage[name] ? computeRecencyBoost(usage[name]) : 0;
   return { ..., score: Math.max(nameScore, descScore) + boost };
   ```

   `computeRecencyBoost` should clamp influence so a high-usage command doesn't outrank a perfect prefix match for a new command (e.g. typing `/exit` should still beat `/extensions` even if `/extensions` was just picked 50 times).

4. Optional: also use frecency for *empty prefix* (when user just typed `/` with nothing after) to surface most-used commands first.

**Cost**: ~80 LOC across two files. One new settings field. One new storage method. No new tool/MCP surface. Token cost: zero (purely client-side ordering).

**Why not reuse FFF for this**: FFF's index is file-system rooted; commands aren't paths. FFF doesn't know about them, doesn't watch the registry for new commands from plugins, and would force a dependency on FFF being loaded just to get good command ordering. Native ordering keeps the feature working when FFF is disabled or absent.

**Follow-up**: same mechanism could extend to `#`-prefixed prompt actions (handled by `PromptActionAutocompleteProvider` at `packages/coding-agent/src/modes/prompt-action-autocomplete.ts:112`) and to MCP slash commands. Land the slash command tier first, generalize later.
