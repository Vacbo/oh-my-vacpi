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
