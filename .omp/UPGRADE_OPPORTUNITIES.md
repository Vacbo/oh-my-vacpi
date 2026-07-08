# Upgrade Opportunities

Running log of vacpi-specific upgrade ideas: prompt bugs, missing features, integration gaps, performance wins. One section per finding. Keep status accurate.

**Status tags**: `[open]` `[in-progress]` `[done]` `[wontfix]` `[deferred]`
**Severity tags**: `[crit]` `[high]` `[med]` `[low]` `[chore]`

## Repository topology (read me first)

This repo is a **fork of a fork**. Three Git remotes are configured; agents working on this codebase MUST keep the directions straight.

| Remote | Repo | Role |
|---|---|---|
| `origin` | `Vacbo/oh-my-vacpi` | This fork. Where vacpi-specific features and prefetches land. |
| `upstream` | `can1357/oh-my-pi` | The intermediate fork ("oh-my-pi"). Adds power-user features on top of pi — most notably MCP server integration, the worktree CLI, the auth-gateway, omp-stats, and the AuthStorage rework. Maintained primarily by `can1357` + the `roboomp` automation account. |
| `pi` | `earendil-works/pi` | The **original** Pi Agent. Maintained primarily by Mario Zechner with Armin Ronacher and others. Source of truth for the core agent/AI/streaming architecture. |

**Direction of code flow** (typical): pi → oh-my-pi → vacpi. Fixes that originate in pi may take weeks to reach oh-my-pi, and may never reach vacpi unless explicitly prefetched.

**Why we forked oh-my-pi instead of going back to pi**: oh-my-pi ships the MCP integration and power-user UX (worktrees, auth-gateway, stats dashboard, etc.) that aren't in the upstream Pi Agent. Rebuilding all of that on top of bare pi would be a multi-week effort with no clear payoff. The trade-off accepted is that oh-my-pi's core code quality is sometimes less mature than pi's — Mario's architectural patterns tend to land later in oh-my-pi via merges or independent reimplementation. When investigating a bug in `packages/ai/` or `packages/agent/`, check `pi/main` first; the fix may already exist upstream.

**Useful git commands**:
```bash
# Survey recent pi work touching a specific area
git log pi/main --oneline -- packages/ai/src/providers/anthropic.ts

# See what pi has that oh-my-pi doesn't yet (one-way)
git log upstream/main..pi/main --oneline -- packages/ai/

# See what pi shipped vs an old vacpi version
git log v15.0.0..pi/main --pretty=format:"%h %ad %s" --date=short -- packages/ai/

# Inspect a specific Mario commit
git show <sha> --stat

# Refresh all three remotes
git fetch --all --tags
```

**Refresh cadence**: `git fetch pi --tags` periodically (Mario ships frequently; the pi `bigrefactor` branch is the place to look for in-flight architectural rewrites). For ongoing oh-my-pi prefetches, `git fetch upstream` first, then survey via `git log upstream/main HEAD..upstream/main --oneline`.

---

## 2026-07-08 — Merged upstream v16.3.11: image cleanup divergence kept, upstream fixes adopted   `[done]` `[med]`

**Merge**: fork `16.3.4` → upstream `v16.3.11`.

**Divergence calls**:
- **Preserved the fork `ImageComponent` transmitted-box cleanup alongside upstream key-map cleanup.** Upstream's new `#forgetKeyForId(id)` only deletes `#idToKey` / `#keyToId`; it does not touch the fork's `#transmittedBoxes` cache. The merge resolution keeps `this.#transmittedBoxes.delete(id)` with upstream's `this.#forgetKeyForId(id)` after transmitted image data is purged, so stale pre-scaled placement boxes do not survive an image eviction.
- **Re-homed fork auth and skill-discovery hooks into upstream session/auth changes.** `auth-storage.ts` keeps the fork `getEnvApiKeyForModel` path while adopting upstream OAuth env helpers and `OAuthAuthInfo`; `agent-session.ts` keeps `collectDiscoverableSkillEntries` while adopting upstream retry recovery typing.
- **Treated generated catalog JSON as disposable.** The `models.json` conflict was unblocked with upstream bytes only so source conflicts could settle; the final artifact must be regenerated from the merged `packages/catalog` sources.

**Residual levers**:
- `packages/tui/src/components/image.ts` remains a map-invalidation hotspot. If upstream grows a single image-id eviction helper, fold the fork `#transmittedBoxes` cleanup into that API and delete the extra fork line.
- Continue regenerating catalog models after merges that touch `packages/catalog/src/provider-models/`, `packages/catalog/scripts/`, or catalog identity/type sources. `packages/catalog/src/models.json` is generated and should never be hand-resolved as the final state.

---

## 2026-07-03 — Merged upstream v16.3.4: fork updater retained, upstream reliability fixes adopted   `[done]` `[high]`

**Merge**: fork `16.3.2` → upstream `v16.3.4`.

**Divergence calls**:
- **Preserved the fork `omp update` merge-session launcher** and discarded upstream's package/Homebrew/mise/binary self-updater implementation again. The fork cannot safely self-replace from upstream packages; only the upstream `-l` plugin-update shorthand was re-homed as a safe `plugins` dispatch path on the fork command. Upstream updater tests for install target detection, binary replacement, and Bun cache pruning were dropped as tests of a dead mechanism; the retained contract asserts normal `omp update` starts the fork merge launcher and `omp update -l` upgrades plugins.
- **Synthesized `ToolExecutionComponent.updateResult`** by keeping the fork's generic "drop partial updates after finalized" guard while retaining upstream's placeholder/partial-result topology reset. This preserves the background async scrollback fix and keeps upstream's TUI repaint-state correction.
- **Adopted upstream's macOS-only SSHFS mount fallback** to avoid false mount positives on Linux when `mountpoint` is unavailable, while retaining the fork-exported `isMountedByDeviceBoundary()` helper used by existing tests and diagnostics.
- **Treated `packages/catalog/src/models.json` as generated output**. The conflict was unblocked from upstream's side, then the catalog generator must be rerun so fork catalog source policies and upstream Baseten/model additions produce the final JSON.
- **Normalized package changelogs by source of truth**: fork entries remain under `### oh-my-vacpi (fork)` in `## [Unreleased]`; upstream `16.3.3` and `16.3.4` released sections are taken from upstream `v16.3.4`.

**Residual levers**:
- `update-cli.ts` remains a standing merge hotspot. Port only behavior compatible with the fork merge-session workflow; do not resurrect upstream self-update installation code unless a future upstream mode becomes source-checkout/jj-aware.
- Keep the generic finalized-partial guard in TUI tool rendering until upstream has an equivalent coverage contract for background `bash` and non-task partial updates.
- Regenerate `models.json` after every merge touching catalog provider descriptors, resolvers, seeds, or generated model policy inputs.

---

## 2026-07-02 — Merged upstream v16.3.2: schema break adopted, fork controls retained   `[done]` `[high]`

**Merge**: fork `16.2.5` → upstream `v16.3.2`.

**Divergence calls**:
- **Adopted upstream's `pi_walker::WalkRequest` workspace scan** instead of resurrecting the fork's deleted `ignore::WalkBuilder` cancellation visitor. Upstream now owns cancellation during collection via `collect_with_heartbeat`; the fork re-added one cheap `ct.heartbeat()?` in the post-collection AGENTS.md loop so aborts still cut off local per-entry stat work.
- **Preserved `todo_write` as the model-facing todo tool name** while adopting upstream's new reminder paths. Literal upstream `"todo"` comparisons in event handling, goal context, mid-run nudges, and plan prompts were re-homed to `todo_write`; obsolete anchored reminder UI clearing was dropped with upstream's replacement mechanism.
- **Synthesized Anthropic adaptive effort policy**: upstream's `isAnthropicAdaptiveGenAtLeast` eligibility brings Sonnet 5+ and future adaptive generations; the fork's API-specific ladders remain so Bedrock Converse keeps `[minimal..high, max]` without baking unsupported `xhigh`, while direct Messages models get the richer `xhigh`/`max` ladder when supported.
- **Kept fork selection restoration and live-session teardown hooks** in the new upstream session-switch/shutdown flow. Upstream's checkpoint-rewind rehydration and bounded Mnemopi dispose were added around the fork's broader tool-selection restoration and live-session unregister path.
- **Normalized generated/catalog and changelog conflicts by source of truth**: `models.json` conflict picks were treated as temporary and must be regenerated from catalog sources; package changelogs keep fork entries under `### oh-my-vacpi (fork)` and take upstream released sections byte-identical from `v16.3.2`.

**Residual levers**:
- The upstream `paths`→`path` search-tool schema break touches prompts, compatibility shims, and extension callers. Keep fork-specific shims only where an observable contract still requires them; otherwise follow upstream.
- `todo_write` remains the highest-frequency merge hotspot. Any new upstream todo reminder, goal, or tool-selection path probably needs a literal-name audit.
- `models.json` must be regenerated after this merge before final verification; hand-resolved JSON is only an unblocker for conflict resolution.

---

## 2026-06-28 — Merged upstream v16.2.5: upstream tool rename adopted, fork updater retained   `[done]` `[high]`

**Merge**: fork `16.1.19` → upstream `v16.2.5`.

**Divergence calls**:
- **Kept the fork updater path** in `update-cli.ts` and `update-cli.test.ts`. Upstream's package/binary self-updater would violate the fork's jj-managed merge workflow, so `/update` remains the fork merge-agent launcher.
- **Adopted upstream's `search`→`grep` and `find`→`glob` builtin rename** while preserving fork public shims and persisted-name normalization. Fork-only `todo_write` remains the model-facing todo tool name; displaceable todo UI paths now compare `todo_write` while keeping the internal `"todo"` displacement kind.
- **Re-homed the fork brush job API onto upstream's relocated vendored crate** at `crates/vendor/brush-core`. The old `crates/brush-core-vendored` path stays deleted; `pi-shell` keeps `JobJoinHandle` and `abort_internal_tasks()` semantics at the live location.
- **Kept fork-open provider API schemas and `Effort.Max`** while adopting upstream remote-compaction/provider-limit schema additions. A closed upstream API enum would reject fork/custom providers.
- **Adopted upstream's todo-tree, idle-recap, remote-compaction, input, and TUI restructures** and reattached fork levers at their new hook points: `applyCwdChange()` for project-dir resets, array-aware setting formatting, slash-command frecency, jj status-line handling, legacy pi bundled registry generation, and terminal recording.

**Residual levers**:
- `todo_write` remains a merge hotspot anywhere upstream compares literal `"todo"` in UI/transcript paths. Keep model-facing name compatibility unless upstream accepts the fork name or a canonical alias layer.
- `update-cli.ts` must continue to bypass upstream self-update code in this fork. Port only merge-agent-safe helper behavior.
- Vendored `brush-core` fork hunks now live under `crates/vendor/brush-core`; future upstream crate relocations need re-home, not resurrection of deleted directories.

---

## 2026-06-25 — Merged upstream v16.1.19: fullscreen extensions adopted, fork pinning retained   `[done]` `[high]`

**Merge**: fork `16.1.16` → upstream `v16.1.19`.

**Divergence calls**:
- **Adopted upstream's fullscreen/mouse Extension Control Center architecture** and re-homed fork skill pinning into it instead of resurrecting the deleted `Container`/manual layout path. The fork keeps `skills.pinnedSkills` toggling, inspector pin provenance, and the shared `TwoColumnBody` export used by the Tool Control Center.
- **Kept fork array-aware settings text formatting** for text settings. Upstream's scalar `String(value ?? "")` fix prevents non-string crashes, but the fork's `formatSettingTextValue()` also preserves array settings such as `skills.pinnedSkills` for round-trip editing and suggestions.
- **Synthesized `/project` command imports** so upstream usage-note sanitization and the fork's project-dir/capability/plugin-root refresh hooks coexist.
- **Adopted upstream's generated OpenRouter GLM pricing conflict** for `models.json`. The fork's `glm-5.2` repricing had converged with upstream, and upstream alone updated `glm-5.1` cache-read pricing; taking the upstream region avoided duplicate generated keys.

**Residual levers**:
- `extension-dashboard.ts` remains a merge hotspot while `/tools` reuses exported internals from `/extensions`. If upstream grows a first-class shared dashboard body component, move the fork Tool Control Center onto that API and stop exporting implementation details from `extension-dashboard.ts`.
- `formatSettingTextValue()` should remain the fork default for settings text rows unless upstream adds equivalent array-aware formatting and suggestion semantics.

---

## 2026-06-24 — Merged upstream v16.1.16: eval/tooling changes adopted, fork levers retained   `[done]` `[high]`

**Merge**: fork `16.1.7` → upstream `v16.1.16`.

**Divergence calls**:
- **Preserved fork model-facing tool names where they are part of local behavior**, especially `todo_write`, while adopting upstream's flattened todo schema (`{ op, list }` instead of `{ ops: [...] }`). The eager-todo prompt and tests were re-homed to the flat shape instead of adding a compatibility shim for the removed wrapper.
- **Kept fork-specific deferred MCP placeholders for explicit `mcp__...` tool names** in UI sessions. Upstream's empty race-window refresh would wipe pending placeholders before discovery completed; this fork gates that refresh during deferred discovery and lets the real discovery callback replace placeholders later.
- **Kept the Fireworks Fire Pass API-key routing path** by preserving `getEnvApiKeyForModel(model.provider, model.id)` in `packages/ai/src/stream.ts`, while adopting upstream's non-null `requestOptions` flow.
- **Kept the six-level fork thinking metadata where it is exposed**, including `Effort.Max`/`ThinkingLevel.Max`, but did not bake unsupported `xhigh` keys into Bedrock Opus 4.6 `effortMap`; runtime legacy-XHigh promotion already maps `xhigh` requests to `max`.
- **Adopted upstream's single-cell eval tool architecture** and updated fork tests to the new `{ language, code, title?, timeout?, reset? }` contract instead of preserving legacy multi-cell call shapes.
- **Synthesized session/MCP cleanup paths**: startup failure now disposes upstream Ruby/Julia eval kernels and the fork live-session registration; MCP connect failures keep the fork's classified error state and upstream's status notifications.

**Residual levers**:
- If upstream restores a batch todo operation or adopts `todo_write`, delete the fork-only prompt/test translation and converge on upstream naming.
- Deferred MCP placeholders remain a merge hotspot around `createAgentSession` and `refreshMCPTools`; re-check `sdk-mcp-defer.test.ts` whenever upstream changes deferred MCP startup.
- The `max` ladder remains split between exposed metadata and selector aliases. If upstream ships a true sixth tier, re-evaluate the fork alias behavior and generated catalog expectations together.

---

## 2026-06-20 — Merged upstream v16.1.7: ArkType/tooling refactors adopted, fork update path preserved   `[done]` `[high]`

**Merge**: fork `16.0.1` + local `feat(coding-agent): tui temporal recording (asciinema + agg)` → upstream `v16.1.7`.

**Divergence calls**:
- **Preserved the fork-owned `omp update` assistant flow** and discarded upstream's legacy npm/Homebrew/mise/binary updater implementation for this fork. The update command still resolves `OMP_VACPI_REPO_DIR` or `~/Dev/oh-my-vacpi`, pins the project dir there, and launches a fresh fork-update session with the static `fork-update.md` prompt. Upstream's Windows binary-backup cleanup is intentionally not re-homed because the fork no longer self-replaces from upstream packages.
- **Adopted upstream's ArkType and OpenAI-family refactors** instead of resurrecting old Zod/inline-provider code. Fork behavior was re-homed into the new architecture: `max` effort remains in schema/model-thinking paths, `getEnvApiKeyForModel` stays on OpenAI completions for model-scoped env lookup, and the Fireworks Fire Pass router exemption now sits inside upstream's split Kimi clamp block.
- **Kept the fork's six-level thinking ladder** (`minimal` → `low` → `medium` → `high` → `xhigh` → `max`) rather than upstream's relabel-only `xhigh`→`max` simplification. This preserves existing fork configs and the catalog Max effort work from the v15.10.12/v16.0.1 merges.
- **Kept jj status-line tracking outside upstream's git-enabled gate**. The fork's jj head label updates before upstream's git segment visibility check, so pure-jj or git-disabled sessions still show the jj bookmark/change label.
- **Preserved the fork's plugin-discovery spy isolation tests** over upstream's new `os.homedir`/XDG test isolation approach. The fork approach is already documented below as fixing order-dependent `DirResolver` memoization and still routes through exported pi-utils directory accessors, so it remains the stronger contract here.
- **Adopted upstream's dependency removals** for `beautiful-mermaid`, `markit-ai`, direct `jszip`, `exifr`, and `music-metadata`; the fork's old `beautiful-mermaid` patch file is gone. Upstream's vendored Mermaid ASCII renderer and document engine are now the maintained path.

**Residual levers**:
- If upstream grows a source-checkout-aware self-update mode, re-evaluate whether the fork-specific update assistant can shrink to a thin wrapper instead of owning the full `update` command.
- The plugin-discovery spy-isolation choice should be revisited if upstream changes `packages/utils/src/dirs.ts` so directory access no longer flows through the exported accessors. Until then, keep fork tests in their own style and do not port them to environment mutation.
- The `max` ladder remains a standing merge hotspot. If upstream adopts a true sixth effort tier, delete the fork-only schema/model-thinking overlays and keep only compatibility migration for old config names.

---

## 2026-06-16 — Merged upstream v16.0.1: dialect/extension cutover with fork tool names preserved   `[done]` `[high]`

**Merge**: fork `15.11.0` + local `feat(coding-agent): add restart tool` → upstream `v16.0.1`.

**Divergence calls**:
- **Preserved `todo_write` as the fork's model-facing todo tool name** while adopting upstream's `todo.eager` / `task.eager` enum semantics (`default | preferred | always`). The upstream reminder and force-active logic were re-homed to resolve `toolRefs.todo` and forced tool choice through `todo_write`, so discovery-all sessions keep the fork contract without losing upstream's preferred-vs-always behavior.
- **Kept the fork's live-session restart path** and added upstream advisor/read-only-tool plumbing to the same `AgentSessionConfig`, rather than choosing either side. `liveSession` disposal now awaits alongside upstream's async Mnemopi disposal.
- **Adopted upstream's `session-entries` split and shared worktree-test fixture** instead of resurrecting the older in-file session-entry definitions and per-test repo setup. The fork's discovery-selection behavior remains through the `mcp_tool_selection` comments and restoration path.
- **Synthesized native scrollback behavior**: upstream's task-specific freeze path remains, but the fork's generic "drop partial updates after finalized" guard stays so background-bash progress cannot respray committed scrollback. The fork's scrollback regression file is retained even though upstream deleted it.
- **Adopted upstream's filtered thinking effort maps in tests**, dropping stale `max`/`xhigh` expectations where explicit model metadata declares a narrower effort set. The fork's `Effort.Max` catalog behavior remains in catalog policy/tests.
- **Synthesized Fireworks provider metadata**: upstream's `kimi-k2.7-code` default wins, fork-only `FIREWORKS_PASS_API_KEY` remains.

**Residual levers**:
- If upstream eventually renames the public todo tool back to `todo_write` or introduces an aliasing layer, delete the fork-only force-active translation and collapse `toolRefs.todo` back to the upstream registry name.
- The retained scrollback tests may overlap future upstream TUI coverage. When upstream lands equivalent native-scrollback tape regressions, compare contracts and drop duplicate fork tests only after the background-bash respray scenario remains covered.

---

## 2026-06-11 — tui_drive/tui_observe cannot verify streaming-render bugs: no history replay, no cross-run diff (scrollback readback shipped same session)   `[open]` `[high]`

**Context**: async-bash progress spray (fixed same day, see coding-agent CHANGELOG): every background-job output chunk recommitted the frozen bash tool box plus the streaming thinking below it into native scrollback, one near-identical copy per tick (`isTranscriptBlockFinalized()` accepted-freeze for `async.state === "running"` blocks vs. `reportProgress` mutating the render → `#auditCommittedPrefix` resync per frame). The user asked for the natural evaluation: recapture the moment from the recorded session, re-render with the fixed code, diff before/after. The current tool surface cannot do that evaluation. Gaps, in decreasing severity:

1. **No deterministic session replay through the live render path.** The spray is a streaming-path artifact (partial tool updates mutating a block the engine already committed). `omp --resume` and the mirror sessions view render the *rebuilt* transcript (final message states), so this bug class is invisible after the fact by construction. Sessions persist messages, not the event stream with timing: there is nothing to feed back through EventController → TranscriptContainer → TUI. Upgrade: an opt-in event-tape recorder (agent events, partial-update deltas, terminal geometry, frame timestamps) plus a replay driver that feeds the tape through InteractiveMode against a ghostty-web `VirtualTerminal` with a virtual clock. That turns "weird render in a screenshot" into a reproducible fixture, and before/after-fix comparison becomes a diff of two deterministic tapes.

2. ~~**`tui_drive` exposes the window, not the tape.**~~ **Shipped same session**: `tui_drive scrollback` returns the full normal-buffer tape (scrollback + screen) as wrap-joined logical lines with `totalLines`/`showingFromLine` and a `limit` tail cap, backed by `TerminalSnapshotRecorder.scrollback()` (the drive emulator already kept 10k lines; only the viewport slice was exposed). An agent can now assert "box chrome rendered exactly once" against a driven repro. Alternate-screen apps get the normal-buffer tape plus a note.

3. **No cross-run capture diff.** `tui_observe render_diff` compares internal snapshot vs. live emulator of the *same* moment. Before/after-fix needs diffing captures from two different builds/runs. With (2) shipped this is two `scrollback` dumps and `diff` in bash; a first-class `tui_drive diff --against <saved capture>` remains optional sugar, not a blocker.

4. **Historical moments are unrecoverable.** Observe snapshots are live-only; per-frame snapshots are not persisted, so a screenshot of a past glitch cannot be reopened as structured state. Subsumed by (1) if the tape lands.

**Workaround used today**: scenario regression test modeled on `packages/tui/test/render-stress-harness.ts` (drives the renderer's real emitted ANSI into a ghostty-web `VirtualTerminal` with a shadow commit ledger): a finalized-but-mutating block with streaming content below at small height; assert the tape contains the block's chrome exactly once. Running the same scenario pre-fix yields one copy per progress tick — that pair is the before/after evidence, deterministic and CI-safe, but it lives at the component level rather than replaying the real session.

---

## 2026-06-10 — Merged upstream v15.10.12: Effort.Max ladder re-homed into pi-catalog; refreshModelThinking dropped   `[done]` `[high]`

**Merge**: v15.10.10 → v15.10.12 (236 upstream commits, 901 files). 42 conflicted paths, dominated by upstream's catalog extraction: the model catalog moved out of `pi-ai` into the new `packages/catalog` (`@oh-my-pi/pi-catalog`), and the TUI render core was rewritten around an append-only native-scrollback contract (`Component.render` now returns `readonly string[]`).

**Fork ports into the new architecture**:
- **Effort.Max ladder** → `catalog/src/effort.ts` (enum member), `catalog/src/model-thinking.ts` (`ANTHROPIC_OPUS_46_EFFORTS` `[minimal..high, max]`, `ANTHROPIC_OPUS_47_PLUS_EFFORTS` `[minimal..xhigh, max]`, Bedrock collapses to the 4.6 shape, `max: "max"` keys on both adaptive effortMaps, legacy-XHigh→Max promotion in `clampThinkingLevelForModel` + `mapEffortToAnthropicAdaptiveEffort`), `identity/markers.ts` (`max` trailing marker), `compat/openai.ts` (effort union). Regenerated `models.json` carries the new ladders (opus-4.6 `[..high, max]`; opus-4.7/4.8/fable-5/mythos-5 six-tier).
- **Fireworks Fire Pass router model** → seed + cap exemption moved to `catalog/provider-models/openai-compat.ts` + `catalog/scripts/generate-models.ts`; `routers/` prefix translation into `catalog/src/fireworks-model-id.ts`; `FIREWORKS_PASS_API_KEY` added to `CATALOG_PROVIDERS` fireworks `envVars`. `getEnvApiKeyForModel` survives in `pi-ai/src/stream.ts` untouched.
- **EFFORT_ORDER** in `coding-agent/src/config/models-config-schema.ts` extended with `max` so legacy `maxLevel: max` configs expand correctly.

**Dropped fork divergence — `refreshModelThinking` re-inference at cache-read sites** (`model-manager.ts`, `model-registry.ts`): structurally obsolete. Upstream removed `enrichModelThinking`/`refreshModelThinking`; thinking is resolved exactly once in `buildModel`, every cache read rebuilds models via `buildModel` (registry sites included), the model-cache schema bumped to v4 (wipes all pre-efforts rows once), and the static-catalog fingerprint invalidates cache merges when `models.json` changes. The two fork regression tests for the old mechanism (`ai/test/model-manager-cache-refresh.test.ts`, `coding-agent/test/agent-session-cycle-stale-cache.test.ts`) were deleted; their derivation contracts now live in `catalog/test/model-thinking.test.ts` (Max ladders, clamp/promotion/mapping invariants).

**Residual lever to remember**: post-v4 cache rows bake `thinking.efforts`, and `resolveModelThinking` trusts explicit baked thinking. A FUTURE fork change to ladder inference will not propagate to already-cached dynamic rows until TTL (24h) or fingerprint change — when extending ladders again, bump `CACHE_SCHEMA_VERSION` in `catalog/src/model-cache.ts` alongside the change.

**Also notable**: jj is now the source-control surface for this repo; git hooks (`omp-rebuild.sh`) do not fire under jj, so post-merge rebuilds are manual (AGENTS.md "Version Control (fork policy)" section records this plus the standing commit/push authorization to `origin`). Upstream's AGENTS.md worker contract (workerHostEntry re-entry, no per-worker `--compile` entrypoints) auto-merged cleanly.

---

## 2026-06-10 — RETRACTED: "cmux paints short bg quads" — striped image was our own mirror render; cmux/Ghostty exonerated   `[done]` `[post-mortem]`

**Original claim (wrong)**: cmux's surface renderer paints SGR row backgrounds at ~83% of cell height at small cell metrics, producing 1-2px stripes of background between rows of tinted blocks. Filed as `[external: cmux]` off pixel forensics of a user-pasted capture (blob `~/.omp/agent/blobs/7ddf4ad0…webp`, 934x690, dips at a strict 11px pitch to `rgb(5,7,10)`).

**What it actually was**: that pasted image is a capture of OUR sessions-server mirror photo render with the pre-fix CSS, not of a live cmux window. Proof, in order of strength: (1) the dip color is exactly `#05070a`, the photo page's literal `background:` value in `sessions-server.ts`; a terminal would show the omp theme background instead. (2) The image has no macOS chrome at all: no traffic lights, no cmux vertical-tab sidebar, no scrollbar; just a bare grid inside a ~12-16px uniform dark margin (`padding: 1rem`) with slightly rounded corners. (3) Pitch math closes: old CSS row pitch `1.35em` x 14px = 18.9px logical; 188 cols x 8.4px advance + 32px padding = 1611px logical; pasted image scale 934/1611 = 0.580; 18.9 x 0.580 = 10.96 ≈ the measured 11.0px period. (4) Source audit of cmux (github.com/manaflow-ai/cmux, native Swift/AppKit embedding libghostty from the `manaflow-ai/ghostty` fork): Ghostty draws cell backgrounds in a fullscreen fragment pass (`cell_bg_fragment` in `src/renderer/shaders/shaders.metal`, `floor((pos - padding) / cell_size)` over a flat per-cell color buffer), which partitions every grid pixel into exactly one cell — inter-row gaps are impossible by construction, at any cell size. The fork's renderer-adjacent patches (preedit row-rebuild guard, `macos-background-from-layer`) don't change this. (5) Scaling/minification of a solid tinted block cannot invent stripes (blending identical colors is the identity), so no downstream downscale could have created them from a clean terminal frame; the paste pipeline (`image-resize.ts`, 1568px/500KB caps) only webp-re-encoded the 934x690 image without resizing.

**Root cause of the stripes**: the mirror photo/page CSS painted cell backgrounds on inline spans (covering only the font content area, ~86% of the 1.35em line box), letting the `#05070a` page background show between rows — fixed the same day in `sessions-server.ts` (inline-block full-height cells, integer px row pitch, shared `terminalStyle()` helper; see coding-agent CHANGELOG).

**Lesson**: before attributing a rendering artifact to an external program from a screenshot, verify provenance first — match background/dip colors against our own page palette (`#05070a` is a fingerprint), check for window chrome, and close the geometry against our CSS metrics. Ghostty note for future reference: announced 2026-04-28 it is leaving GitHub (read-only mirror remains; ghostty.org canonical); cmux pins fork `manaflow-ai/ghostty`, docs in repo `docs/ghostty-fork.md`.

## 2026-06-10 — `tui_drive` batched named keys mis-parse in full-screen component input   `[open]` `[med]`

**Where**: `packages/coding-agent/src/tools/tui-drive.ts` (input action writes text, then every named key back-to-back), `packages/coding-agent/src/modes/components/extensions/extension-dashboard.ts` / `tools-dashboard.ts` `handleInput` (whole-chunk `matchesKey` checks), `packages/tui/src/keys.ts` (`encodeKey`).

**Incident**: 2026-06-10, driving the new Tool Control Center: `input keys: ["escape","right","right"]` arrived as one PTY chunk (`\x1b\x1b[C\x1b[C`). `matchesKey(chunk, "escape")` failed on the multi-key chunk, the dashboard fell through to the list, and `extractPrintableText` appended a literal `[C` to the search query ("find[C", "No extensions found"). Sending one key per `input` call behaves correctly.

**Mechanism**: component-level `handleInput(data)` receives raw chunks and only matches single-key sequences; batched writes (fast typists, paste, automation) degrade into printable garbage. This is generic to every full-screen overlay using the whole-chunk pattern, not specific to one dashboard.

**Fix sketch**: either (a) `tui_drive` flushes each named key as its own PTY write with a small inter-key gap, or (b) pi-tui gains a chunk segmenter (scan with the existing key parser, split into discrete key events) that overlay `handleInput` paths share. (b) also fixes real-world paste/fast input, so it is the better long-term home; (a) is a one-liner stopgap in the drive session manager.

## 2026-06-10 — Extension/Tool dashboards cannot search terms containing `j`/`k`   `[open]` `[low]`

**Where**: `packages/coding-agent/src/modes/components/extensions/extension-list.ts` `handleInput` (printable chars route to search, but `"j"`/`"k"` return early as list navigation).

**Mechanism**: vim-style nav keys are checked before search input, unconditionally. Queries like "job", "task_update", or any skill/tool name containing j/k are untypable in /extensions and /tools; the characters silently scroll the list instead.

**Fix sketch**: treat `j`/`k` as navigation only while the search query is empty (first keystroke), and as search input once a query exists; arrow keys keep working for navigation either way. One conditional in `ExtensionList.handleInput`, plus a regression test typing "job" into the search.

## 2026-06-10 — Mirror screenshots are rendered by the HOST omp's sessions-server, so source fixes lag until restart   `[open]` `[low]`

**Where**: `packages/coding-agent/src/tools/tui-observe.ts` (`getSharedMirror` starts the loopback sessions-server in the tool host process), `packages/coding-agent/src/cli/sessions-server.ts` (photo page).

**Incident**: 2026-06-10, after fixing the photo page's `.sr-text` strip and font fallbacks at source, `tui_drive screenshot` of a *source-run* child still showed the old artifacts: the capture is served by the host session's (older) binary, not the driven child's code. Easy to misread as "fix didn't work" during UI verification; had to spin up a sessions-server from source on a side port to verify.

**Fix sketch**: stamp the photo page (and the screenshot result JSON) with the serving build's version so staleness is visible at a glance; optionally add a `tui.mirror.preferSource` dev escape hatch or restart the shared mirror when the binary's mtime changes. Low priority: only bites when iterating on the mirror itself.

## 2026-06-10 — Slash picker ranks `/export` above `/exit` on short prefixes; usage boost entrenches the misfire   `[open]` `[low]`

**Where**: `packages/tui/src/autocomplete.ts:127-148` (`fuzzyScore`: exact 100, starts-with 80), `:228-239` (`computeSlashUsageBoosts`: MRU rank 0 → +15), `:344-373` (sort by `matchScore + usageBoost`, stable), `packages/coding-agent/src/slash-commands/builtin-registry.ts:262` (`export`) vs `:1098` (`exit`) vs `:1677` (`quit`), `packages/coding-agent/src/modes/controllers/input-controller.ts:602-604,871-874` (usage recording, includes `/skill:` names), `packages/coding-agent/src/session/agent-storage.ts` (`slash_command_usage` table).

**Incident**: 2026-06-10, two accidental `/export`s (multi-MB session HTML dumped into the repo root, since gitignored as `omp-session-*.html`) while trying to exit the TUI.

**Mechanism**: For prefix `ex`, both `exit` and `export` are starts-with matches at fuzzyScore 80. The sort is stable, so ties fall back to registry registration order, and `export` (line 262) precedes `exit` (line 1098); the top item is what Enter accepts. This trap predates frecency. The usage boost then entrenches it: one accidental export records usage, the next `/ex` scores export 95 vs exit 80, and every repeat re-records, so the misfire is self-reinforcing. Typing `/exit` in full is safe (exact match 100, and "exit" is not a subsequence of "export"). `/q` is currently a unique prefix for `quit`.

**Ranking ownership** (clarified same day): the env-level `@ff-labs/pi-fff` plugin only ranks files: FFF-backed `@` autocomplete plus `fffind`/`ffgrep` tools, with a frecency DB of file access. Slash commands and `/skill:` entries are ranked exclusively by the fork-native `slash_command_usage` path above. The two systems share no storage or scoring; "pi-fff handles reranking" holds for `@` mentions only.

**Fix sketch — learn from FFF's algorithm** (`fff-core/src/score.rs`, the engine behind pi-fff; read 2026-06-10): FFF never lets history beat relevance because its boosts are multiplicative fractions of the match score (`frecency_boost = base_score * frecency / 100`, git boost `base * 15/100`, exact-filename bonus `base * 40%`), and it keeps a query-to-choice combo memory (`last_same_query_match` + `open_count`): picking a result for a given typed query boosts that exact pair next time. Port both ideas to the commands picker:

1. Replace the flat `+15` MRU boost with a multiplicative one (`base * usageRank%`), so equal-relevance ties stop being decided by global popularity alone.
2. Record `(typed prefix → picked command)` pairs in `slash_command_usage` (add a `query` column) and boost pair hits first; one corrective `/exit` pick after typing `ex` then flips the ranking permanently, making the picker self-healing instead of self-entrenching.
3. Adopt FFF's decomposed `Score` shape (`{ base, usageBoost, pairBoost, exactnessBonus, total, matchType }`) in a pure `scoreSlashCommand()` in pi-tui, unit-tested with the `ex` → exit/export case as the regression fixture. That decomposition is what "enables easy upgrades": ranking policy changes become one-component diffs with visible blame, and `/fff-health`-style debugging (show per-component scores in the picker under a debug flag) comes free.
4. Cheapest interim guard independent of the above: tie-break equal scores by shorter name, so `exit` precedes `export` at `ex` even before any history exists.

## 2026-06-10 — `sem` entity diffs cover `git diff` only; jj-colocated repos bypass them   `[open]` `[low]`

**Where**: [`sem`](https://github.com/Ataraxy-Labs/sem) (Ataraxy Labs), installed environment-wide via `sem setup`, which replaces `git diff` output with entity-level diffs for everything that shells out to git. Not part of vacpi or the harness: it lives in Pedro's code environment, so do not grep this repo for its "N entities, M unchanged filtered out" summary. Fork-side surface that could host an equivalent: `crates/pi-shell/src/minimizer/filters/` (cargo.rs et al.).

**What sem is** (worth knowing when coding here): Rust + tree-sitter semantic VCS layer on git. Diffs at entity granularity (functions/classes/methods, 31 languages plus JSON/YAML/TOML/Markdown), three-phase matching (exact id, structural hash, >80% token fuzzy) so renames/moves and cosmetic-only changes are classified, not shown as add+delete pairs. Agent-native surfaces: `--format json|markdown|plain`, `sem impact <entity>` (dependency blast radius), `sem context <entity> --budget N` (token-budgeted LLM context), `sem blame`/`sem log` (entity history), an MCP server (`sem_diff`, `sem_impact`, `sem_context`, ...), and a `SKILL.md` in-repo.

**Problem**: Two gaps observed live (2026-06-10 session):

1. **No jj coverage.** This repo is jj-colocated and agents are steered toward jj commands, but jj never invokes `git diff` (it diffs the git object store itself), so `jj diff --git` returns raw line hunks with no entity rendering. Inverse problem too: when an agent needs raw bytes, `git diff` cannot provide them because sem always rewrites the output, so the agent must know to flee to `jj diff` as the un-intercepted path. Behavior should be symmetric: render both, and keep a raw escape hatch for both.
2. **`git diff --output=<file>` is swallowed.** The sem-wrapped `git diff` rendered the entity summary to stdout and left the `--output` target empty (0 bytes), silently destroying the requested raw capture. Output-redirecting flags should either pass through unwrapped or be honored after rendering. Candidate upstream issue for Ataraxy-Labs/sem.

**Fix sketch**: jj exposes the integration point natively: `ui.diff-formatter` in jj config invokes an external tool with left/right trees, so a small glue (or an upstream `sem diff <dirA> <dirB>` directory-compare mode; file-pair and `--stdin` modes already exist) gets `jj diff` the same rendering with zero interception hacks. Alternatively, or additionally, a native fork filter in `crates/pi-shell/src/minimizer/filters/` could shell to `sem diff --stdin` for git/jj diff output, so the capability ships with vacpi. Either way, pass through any invocation carrying `--output`/`-o` untouched.

## 2026-06-10 — Goal mode is TUI-only; `goal.continuationModes` has one consumer; headless `-p` lacks a budgeted objective primitive   `[done]` `[med]`

**Where**: `packages/coding-agent/src/modes/interactive-mode.ts:841-875` (goal continuation pump, sole consumer of `goal.continuationModes`), `packages/coding-agent/src/config/settings-schema.ts:2713-2721` (the setting), `packages/coding-agent/src/modes/print-mode.ts` and `src/modes/rpc/` (zero goal references), `packages/coding-agent/src/cli/args.ts` (no goal flag), `packages/coding-agent/src/session/agent-session.ts:868,1235,4177` (session-level `GoalRuntime`), `packages/coding-agent/src/goals/runtime.ts`.

**Problem**: `GoalRuntime` (persistent objective, token and wall-clock budget accounting, `goal` tool, continuation prompt rendering) is hosted by `AgentSession` and is mode-agnostic, but the activation surface and the continuation pump exist only in interactive mode. The schema already anticipates more hosts: `goal.continuationModes` is an array setting described as "Run modes where active goals may auto-continue between turns", defaulting to `["interactive"]`. Yet `interactive-mode.ts:841` is its only consumer, so configuring `["interactive", "print"]` silently does nothing. Print mode and RPC mode contain zero goal references and `args.ts` exposes no `--goal`/`--goal-budget`. Net effect: headless `omp -p` has no budgeted, self-terminating autonomy primitive, so unattended workflows (the Codacy quality loop plan, robomp-style drivers) must rebuild externally what goal mode already models internally. `/loop` is also TUI-only, but a shell loop around `omp -p` replaces it trivially; goal mode is the real gap because budget accounting, continuation semantics, and completion detection live in session state.

**Fix sketch**: (a) Print mode: add `--goal "<objective>"` and `--goal-budget <N>`; seed the session's `GoalRuntime` before the first turn, and after each agent yield pump a `goal-continuation` submission while `goal.continuationModes` includes `"print"`, until goal completion, budget exhaustion, or a turn cap; map the final goal status to the exit code so orchestrators can branch on it. (b) RPC mode: expose goal set/show/pause/resume/drop/budget methods and honor `"rpc"` in `continuationModes`. (c) Extract the ~40-line continuation pump from `interactive-mode.ts:841-875` into a shared host driver so all modes get identical semantics (suppression on user input, single in-flight continuation). TUI default behavior unchanged. If (a) lands, the Codacy loop's worker invocation can swap its single `-p` prompt for `-p --goal` with a per-item budget and inherit self-termination for free.

**Unification note (2026-06-10)**: `/loop` and `/goal` are two hardcoded policies of the same mechanism. Both pumps are armed at the identical point (`getUserInput()`, interactive-mode.ts:804-805), share the 800ms Esc grace window, and are mutually exclusive (loop wins, :839). They differ on exactly three axes: injected message (loop replays the captured user prompt verbatim via `input-controller.ts:418`; goal renders a state-templated continuation with live budget numbers), termination authority (loop: external counter/deadline the agent cannot end early; goal: agent-declared completion via the `goal` tool, with budget exhaustion soft-flipping the injection to wrap-up), and persistence (loop: TUI-process memory; goal: session state with pause/resume/drop). Provenance confirms accretion rather than design: loop landed 2026-04-29 (`4f45cf1fb`), count/duration limits 2026-05-07 (`d124402cb`), goal mode 2026-05-14 (`933058a24`), all can1357, never unified. (d) When extracting the shared driver in (c), model continuation as one primitive `(messageGenerator, terminationPredicate, contextPolicy)`: loop = (constant, counter|deadline, prompt|compact|reset), goal = (templated, agentDeclared+budget, accumulate). That makes currently inexpressible combinations (goal with iteration cap, loop-until-agent-declares-done, reset-based goal) fall out for free, and gives headless `-p` one continuation surface instead of two. Fork policy: build fork-side, no upstream PR (this fork diverges deliberately). To keep the recurring upstream merges cheap, land the shared driver in new files (e.g. `src/modes/continuation/`) and keep the `interactive-mode.ts` hooks to a few lines; `loop.mode` and `goal.continuationModes` collapse into one policy config. Also treat this as reference design for the ground-up Rust harness in `~/Dev/vacpi_workspace`, where continuation should be one primitive from day one.

**Shipped in fork (2026-06-11)**: Fix sketch (a) plus the pump extraction from (c). `omp -p "<prompt>" --goal "<objective>" [--goal-budget <tokens>] [--goal-turns <N>]` seeds `GoalRuntime` before the first turn, pumps `goal-continuation` turns after the initial prompts, and maps the outcome to the exit code (0 complete, 1 error, 2 budget-limited, 3 turn cap, 4 dropped, 5 paused). The decision logic was extracted into `modes/continuation/goal-continuation.ts` (`decideGoalContinuation`, consumed by both the interactive pump and the new fork-owned print driver `modes/continuation/print-goal.ts`). Deliberate deviation: print consent is the `--goal` flag itself, not `goal.continuationModes` including `"print"`. A flag-seeded goal that refused to pump unless a setting also listed "print" would make the flag look broken, and no other path can produce an active goal in print mode (`onThreadResumed` auto-pauses). Not included: RPC goal methods (b) and the `/loop` unification, since the generic `(messageGenerator, terminationPredicate, contextPolicy)` primitive would have one consumer today; `modes/continuation/` is its future home.

## 2026-06-09 — Discovery-hidden built-ins vanish across resume; eager-todo forceActive checks a dead tool name   `[done]` `[high]`

**Where**: `packages/coding-agent/src/sdk.ts` (forceActive block, `restored` set wiring), `packages/coding-agent/src/session/agent-session.ts` (`#selectedDiscoveredToolNames`, `#persistSelectedMCPToolNamesIfChanged`, `#restoreMCPSelectionsForSessionContext`), `packages/coding-agent/src/session/session-manager.ts` (`mcp_tool_selection` entry).

**Problem**: Observed live during the v15.10.9 merge session: `todo_write` failed with "Tool todo_write not found" mid-conversation even though the session's todo list already had 8 items, and the model had to re-discover it via `search_tool_bm25`. Three concrete defects:

1. **No persistence for built-in activations.** BM25-activated built-ins live only in the in-memory `#selectedDiscoveredToolNames` set. The `mcp_tool_selection` session entry persists MCP names only; sdk.ts even carries upstream's comment "built-in activation persistence is a follow-up". Any process restart or resume re-hides every discoverable built-in the model had activated, while the conversation history still says the tool exists.
2. **Dead forceActive guard (fork name drift).** sdk.ts checks `toolRegistry.has("todo")` before force-keeping the eager-todo tool active. Upstream renamed their tool `todo_write` to `todo` (`dc4aeb7b8`); the fork kept `todo_write`. The guard can never fire here, so with `todo.eager` on and `tools.discoveryMode: "all"`, the tool is hidden at assembly and the eager prelude silently no-ops (its own guard at agent-session `#createEagerTodoPrelude` correctly checks the active set and skips).
3. **In-process session switch drops built-ins too.** `#restoreMCPSelectionsForSessionContext` rebuilds actives as current-non-MCP + restored-MCP, so the target session's built-in activations are never restored and the previous session's selections leak forward.

**Fixed in fork (2026-06-09)**: The `mcp_tool_selection` entry now persists the union (MCP + active discovered built-ins; names cannot collide, MCP tools carry the `mcp__` prefix, exactly the back-compat path upstream's comment anticipated). `#selectedDiscoveredToolNames` is seeded from the restored entry at construction, `#restoreSelectionsForSessionContext` (renamed) reseeds built-in selections on in-process switch, branch, and history rewind, and the forceActive computation moved to `computeForceActiveToolNames()` (tools/index.ts) using the fork's `todo_write` with a regression test that every forced name resolves to a registered built-in. Verified by a resume round-trip test in `sdk-mcp-discovery.test.ts` (activate built-in, dispose, reopen, assert active + selected). Upstream PR candidate: the same persistence gap exists upstream (their comment admits it); the helper + test also protects them from the next rename.

## 2026-06-09 — Harness behaviors hardcode tool names; plugins cannot shape the system prompt structurally   `[open]` `[med]`

**Where**: `packages/coding-agent/src/session/agent-session.ts` (eager prelude, todo reminders, plan-mode enforcement all hardcode tool name literals), `packages/coding-agent/src/sdk.ts` (`rebuildSystemPrompt`), `packages/coding-agent/src/extensibility/extensions/runner.ts` (`emitBeforeAgentStart`).

**Problem**: Every harness behavior that targets a tool spells its name as a string literal at each site (`todo_write` at `#createEagerTodoPrelude`, `ask`/`resolve` at plan-mode enforcement, `todo` in upstream's sdk.ts forceActive). Renames silently kill behaviors (see the `[high]` entry above). Separately, extensions can only mutate the system prompt as a raw `string[]` via `before_agent_start`; there is no way to replace or remove a specific section, and prompt content does not adapt when a plugin supersedes a built-in capability (e.g. team-mode `task_*` tools coexist with the hidden `todo_write` while the prompt still describes the built-in todo flow).

**Fix sketch (layered)**: (a) Capability table: tool definitions declare `provides: "todo" | "plan" | ...`; eager prelude, reminders, forceActive, and plan-mode enforcement resolve "the active tool providing X" through the registry instead of literals; plugins declaring a capability supersede the built-in. Capability means a minimal behavioral contract (args shape a forced tool_choice can rely on), not just a label. (b) Structured system prompt: assemble named ordered sections derived from the capability table; additive extension hook `{ add, replace, remove }` by section id with deterministic ordering and a logged diff; keep the `string[]` hook for back-compat. Propose (b) upstream before building to avoid extension-API divergence.

## 2026-06-09 — Fork Anthropic max_tokens policy is interleaved inside upstream's buildParams   `[done]` `[high]`

**Where**: `packages/ai/src/providers/anthropic.ts` (`buildParams` max_tokens default, `ensureMaxTokensForThinking`), `packages/ai/test/anthropic-alignment.test.ts`.

**Problem**: The fork's output-budget policy (the `/3` no-explicit-maxTokens default plus the adaptive-thinking raise with caller-override skip) is spliced line-by-line into upstream's `buildParams` and `ensureMaxTokensForThinking`. This is the third consecutive merge (v15.10.0, v15.10.9, v15.10.10) that conflicted on exactly these lines; v15.10.10 also changed the cap semantics under us (unconditional 64k became OAuth-conditional `maxOutputTokens`), so the fork code had to be re-derived rather than re-applied.

**Fix sketch**: Extract the entire fork policy into one fork-owned function, e.g. `applyForkOutputBudget(params, model, options, maxOutputTokens)`, called once at the end of `buildParams`. Upstream restructures then produce at most a one-line conflict at the callsite instead of three multi-line conflicts in interleaved bodies. The 2026-06-09 resolution kept the inline shape; do the extraction as a standalone commit after the merge settles.

**Shipped in fork (2026-06-11)**: Extraction landed exactly as sketched. `buildParams` and `ensureMaxTokensForThinking` are byte-identical to upstream v15.11.0 again; the whole policy (the `/3` default, the OAuth-conditional cap interplay, the adaptive carve-out) lives in fork-owned `applyForkOutputBudget`, called on one inserted line after `ensureMaxTokensForThinking`. The function re-runs upstream's `ensureMaxTokensForThinking` after lowering the default so enabled-thinking budgets re-fit through upstream's own raise/clamp logic instead of a duplicated copy (the no-double-clamp equivalence holds because a first clamp always leaves `budget + buffer <= cap`). Wire behavior unchanged: all 80 pre-existing anthropic param tests passed without modification before the test relocation below.

## 2026-06-09 — Fork-contract assertions live inside upstream test files   `[done]` `[med]`

**Where**: `packages/ai/test/anthropic-alignment.test.ts` (the `/3` default tests, the API-key ceiling test rewritten this merge), `packages/coding-agent/test/agent-session-eager-todo.test.ts`.

**Problem**: Fork behavior divergences are tested by editing upstream's test files in place. Upstream rewrites these files every release, so each merge surfaces them as conflicts or post-merge failures that need manual re-derivation (this merge: upstream's new "keeps the full model output ceiling for API-key requests" test asserted their no-`/3` default and had to be split into a fork pair).

**Fix sketch**: Move fork-contract tests into fork-owned files (e.g. `packages/ai/test/fork-anthropic-output-budget.test.ts`) and leave upstream's files byte-identical to upstream wherever the contract genuinely diverges; delete the upstream test of the replaced default in one tightly-scoped hunk instead of rewriting it. Merges then auto-resolve the fork files and the diff against upstream stays reviewable.

**Shipped in fork (2026-06-11), scoped to packages/ai**: `fork-anthropic-output-budget.test.ts` now owns the whole output-budget contract: the relocated `/3` default and 64k-cap tests, the folded-in `anthropic-adaptive-max-tokens.test.ts` (one fork function, one contract file), and new coverage for /3-exceeds-cap clamping (OAuth vs API key), the enabled-thinking re-fit raise, and over-ceiling budget clamping. `anthropic-alignment.test.ts` restored to upstream bytes except one contiguous deletion hunk (upstream's three replaced-default tests) and the `Effort.Max` efforts token, which belongs to the effort-ladder feature, not this entry. Deliberate non-action on `agent-session-eager-todo.test.ts`: its `todo` → `todo_write` renames are forced by the fork's tool registry (irreducible in-place divergence), and relocating the one fork-added test would duplicate the ~180-line AgentSession harness, which drifts with upstream session-construction APIs and would cost more per merge than the insert-only hunk it replaces.

## 2026-06-09 — TeeTerminal mirrors the Terminal interface member-by-member   `[open]` `[med]`

**Where**: `packages/tui/src/terminal.ts` (`TeeTerminal`).

**Problem**: The fork's `TeeTerminal` re-implements all ~17 members of `Terminal` as manual one-line forwards. Every upstream interface change breaks the fork build: v15.10.10 removed `Terminal.isNativeViewportAtBottom()` and the stale forward was the only `bun check` failure of the whole merge. The only real logic is the `write()` tap.

**Fix sketch**: Either (a) build the tee with a `Proxy` over `inner` that special-cases `write`, so interface drift is absorbed automatically, or (b) propose a `onWrite?: TerminalWriteListener` tap upstream on `ProcessTerminal` itself, which would delete the fork class entirely. Option (b) is the durable one; the recorder use case (terminal snapshots) is not fork-specific in principle.

## 2026-06-09 — DirResolver memoization makes XDG-based test isolation order-dependent   `[in-progress]` `[high]`

**Where**: `packages/utils/src/dirs.ts` (`DirResolver`, module-level `dirs` singleton, `RESOLVER_HOME` captured at load), `packages/coding-agent/test/plugin-extensions-discovery.test.ts`.

**Problem**: `getPluginsDir()` resolves through a module-level `DirResolver` that captures env state and memoizes subdir paths. Tests that point `XDG_DATA_HOME` at a temp dir only get the temp path if no earlier test file in the same process already resolved the plugins dir. In the v15.10.10 full suite, all 9 `plugin-extensions-discovery` tests fail deterministically with their own isolation guard ("getPluginsDir() returned ~/.omp/plugins, outside tempXdgDataHome") while passing standalone. The guard throwing instead of writing to the real `~/.omp/plugins` is good defensive design; the underlying cached-singleton-vs-env-mutation pattern is the flaw. Confirmed upstream-inherent on a pristine v15.10.10 worktree: the same guard trips in upstream's own full suite (1 to 9 tests depending on parallel scheduling), so this is not caused by fork changes.

**Incident (2026-06-09, data loss)**: This flaw escalated from test noise to real damage. During v15.10.10 merge classification, the pristine upstream suite (which lacks the fork's write-guard) ran against the real `$HOME` from a `/tmp` worktree: the unguarded `dir-entry-plugin` fixture resolved `getPluginsDir()` to the real `~/.omp/plugins`, ran `fs.rmSync(node_modules)` and replaced `package.json`, wiping the live plugin install (5 plugins). Root cause chain in `dirs.ts`: (1) XDG redirection is gated on `agentDir === defaultAgent` (line ~131); (2) `setAgentDir()` from any earlier test file leaks a non-default agent dir through the singleton and `PI_CODING_AGENT_DIR`; (3) the test captured `getAgentDir()` at module load, re-pinning the leaked dir and silently disabling XDG. Recovery: `package.json` reconstructed from the untouched `bun.lock` workspace block, `bun install --frozen-lockfile`, enable state intact via `omp-plugins.lock.json` (context-guard stayed disabled).

**Fixed in fork**: `plugin-extensions-discovery.test.ts` no longer touches env at all; it spies `getPluginsDir`/`getPluginsNodeModules`/`getPluginsPackageJson`/`getPluginsLockfile` (each individually, since `dirs.ts` composes them via intra-module calls the namespace spy cannot intercept), matching `plugin-install-local.test.ts`, with a tripwire kept before any destructive write and `mock.restore()` in `afterEach`. The 9 full-suite failures are gone.

**Still open (upstream)**: the `DirResolver` singleton flaw itself, and upstream's unguarded copy of the test. PR candidate: a `resetDirResolver()` seam plus the spy-based isolation. Process rule until then: NEVER run upstream's coding-agent suite against a real `$HOME`; use `HOME=$(mktemp -d)` for baseline classification runs.

## 2026-06-09 — Machine-parsed `git diff` honors host diff.external   `[done]` `[high]`

**Where**: `packages/coding-agent/src/utils/git.ts` (`buildDiffArgs`, `diff.has`); consumer `packages/coding-agent/src/task/worktree.ts` (`captureRepoDeltaPatch`, baseline capture, untracked patches).

**Problem**: Every `git.diff()` output path is machine-consumed — parsed by `parseFileDiffs`/`parseNumstat`/`parseCommitDiffHunks` or piped into `git apply` — yet the invocation honored `diff.external`/`GIT_EXTERNAL_DIFF`. On a host with an external differ configured (here: `sem`), `git diff` emits presentation output instead of patch syntax, so `git apply` rejects the delta patch and task-worktree merge-back breaks at runtime. Surfaced as 3 deterministic test failures (`worktree.test.ts` ×2, `issue-966-repro`) that looked environmental but were a product bug. `git diff-tree` (used by `diff.tree`) is plumbing and already ignores external diff unless `--ext-diff` is passed; `jj diff --git` and `gh pr diff` are unaffected.

**Fixed in fork**: `buildDiffArgs` now emits `git diff --no-ext-diff --no-textconv ...` (textconv output is equally un-applyable); `diff.has` adds `--no-ext-diff` so the `--quiet` exit code never depends on `diff.trustExitCode`. One test-side assertion in `worktree.test.ts` that shells `git diff` directly got the same flag. Upstream PR candidate: identical patch applies to upstream `utils/git.ts`, which has the same flaw.

## 2026-06-09 — wrapFetchForCch silently changes the FetchImpl body contract   `[open]` `[low]`

**Where**: `packages/ai/src/providers/anthropic.ts` (`wrapFetchForCch`), consumer mocks like `packages/coding-agent/test/tools/web-search-anthropic.test.ts`.

**Problem**: The cch wrapper re-issues the request with `body` converted from `string` to `Uint8Array`. Type-correct (both are `BodyInit`), but every downstream `FetchImpl` consumer that assumed string bodies breaks at runtime, not compile time; the fork's web-search mock failed with an opaque `JSON Parse error` this merge. Anything else that wraps or intercepts fetch (auth-gateway, stats capture, future test mocks) has the same latent hazard.

**Fix sketch**: Fixed the fork mock to decode both shapes. Longer term, a shared test helper (`decodeFetchBody(init)`) in pi-ai's test utils would keep the knowledge in one place; grep for other `init.body as string` assumptions when touching auth-gateway interceptors.

## 2026-06-09 — Removed settings disappear silently from settings-schema   `[open]` `[low]`

**Where**: `packages/coding-agent/src/config/settings-schema.ts`.

**Problem**: v15.10.10 deleted `clearOnShrink` (upstream) and the merge deleted the fork's `tui.rebuildScrollbackDuringStreaming`; both vanish from the schema and stale user config entries are ignored without a word. A user who opted into the fork setting gets a behavior change (always-on append-only commit semantics) with no signal about why or that their config line is now dead.

**Fix sketch**: Add a `removedSettings: Record<string, string>` map (key to one-line reason) consulted at settings load; log one `logger.warn` per stale key found. A few lines, no schema machinery. Worth proposing upstream since they remove settings regularly.

## 2026-06-09 — Changelog union-driver normalization is a manual chore every merge   `[open]` `[chore]`

**Where**: `packages/*/CHANGELOG.md` (`merge=union` driver), `scripts/fix-changelogs.ts`.

**Problem**: Every upstream merge requires the same hand-edits: insert the missing blank line at the seam between the fork's `### oh-my-vacpi (fork)` block and upstream's first versioned heading, move upstream entries out of `## [Unreleased]`, and prune fork entries superseded by upstream changes. Done by hand three merges in a row.

**Fix sketch**: Extend `scripts/fix-changelogs.ts` with a `--post-merge` mode that fixes seam blank lines and flags (not auto-edits) fork entries mentioning identifiers that no longer exist in the tree. Wire it into the `omp update` merge-session prompt so the agent runs it instead of re-deriving the rules.

## 2026-05-26 — Hindsight integration: per-harness observability gaps   `[open]` `[med]`

**Where**: `packages/coding-agent/src/hindsight/{state.ts,backend.ts,client.ts,content.ts}`, plus `packages/coding-agent/src/slash-commands/builtin-registry.ts` for the proposed `/memory list`.

**Context**: User runs Hindsight across multiple coding harnesses (vacpi + Codex + Claude integrations) targeting a shared `Vacbo` bank. Wants to evaluate which harness produces what kind of memories and tune accordingly. Current vacpi flow is "send full session transcript on `agent_end` gated by `retainEveryNTurns`; Hindsight server extracts/dedups/consolidates." All the cross-harness comparison friction lives at the metadata/tooling layer, not the wire protocol.

### Confirmed flow (read-only audit, no changes)

- **Sent**: flat plain-text transcript of user + assistant messages only. Tool calls, results, bash, thinking, custom messages are dropped. `<memories>` and `<mental_models>` tags are stripped before send (anti-feedback loop).
- **Triggered**: `HindsightSessionState.attachSessionListeners` subscribes to `agent_end`. `maybeRetainOnAgentEnd` gates on `userTurns - lastRetainedTurn >= retainEveryNTurns`.
- **Wire**: `POST /v1/default/banks/Vacbo/memories` with `{ items: [{ content, document_id: <session-id>, tags: ["project:<basename>"], context: "Pi Coding Agent session transcript", metadata: { session_id } }], async: true }`. Stable `document_id` makes Hindsight treat re-uploads as document-replace + re-consolidate (full-session retainMode behavior).
- **Server-side decision**: Hindsight runs LLM extraction → typed memory items (`experience`, `world`, `decision`, etc.) → dedup against existing bank memories → consolidate. Harness is dumb; Hindsight is the editor.

### Recommended upgrades (none implemented)

1. **`harness:vacpi` retain tag** `[high]` — add to `retainTags` in `HindsightConfig` (or always-append in `retainSession`). Other harnesses' plugins add their own tag. Then the Hindsight UI / `listMemories` query can filter by `tag = harness:vacpi` for direct per-harness comparison. ~5 LOC. **Coordination cost**: requires the Codex and Claude Hindsight plugins to adopt matching `harness:<name>` tags for the comparison to be symmetric.

2. **`/memory list` slash command** `[med]` — vacpi has `/memory clear` and `/memory enqueue` but no list. `HindsightApi.listMemories(bankId, { limit, offset, q })` already exists in `client.ts:330`. Add a TUI renderer (item table grouped by type, with metadata + tag preview). ~50 LOC, makes the bank browseable without opening the Hindsight UI or installing the MCP server.

3. **Document the `retainMode` trade-off** `[low]` — `"full-session"` produces fewer, larger, contextually-rich memories per session (one document replaced on each retain). `"last-turn"` (the OpenCode plugin default) produces many small turn-scoped memories. Pick deliberately per harness based on whether granularity or context dominates. Currently vacpi defaults to `"full-session"` but there's no user-facing docs explaining when to choose what. Either add a paragraph to `DEVELOPMENT.md` or a tooltip in `/memory` settings UI.

4. **Hindsight hook event family** `[low]` — Hindsight is a privileged `MemoryBackend`, not a hook plugin; consequently its operations are opaque to other extensions. Emitting `hindsight.retained` / `hindsight.recalled` / `hindsight.mental_models_loaded` events from `HindsightSessionState` at the same points the internal subscriptions fire would let observability plugins react. ~50 LOC, zero behavior change. Only worth shipping if a concrete consumer plugin is on the horizon.

### Architectural note

Hindsight is wired via the internal `MemoryBackend` interface (`packages/coding-agent/src/memory-backend/types.ts`), **not** the public hook API. This is intentional — the public hook system can't mutate the system prompt before generation, but `MemoryBackend.buildDeveloperInstructions` + `beforeAgentStartPrompt` can. The trade-off is opacity to other extensions (gap #4 above). Codex's Hindsight plugin uses hooks because Codex has no `MemoryBackend` equivalent; that's a Codex architectural limitation, not a model to follow.

### Workarounds available today (no code)

- Inspect the bank in the Hindsight UI: filter by `tag = project:<basename>`. The `metadata.session_id` field distinguishes which session wrote each memory; with multiple harnesses, you may be able to fingerprint session-id format per harness to attribute origin.
- Compare `context` field per memory — vacpi sets `"Pi Coding Agent session transcript"`; other harnesses set their own string (or nothing).
- Memory shape itself is a strong signal: vacpi's full-session retains produce coarser, more contextual memories than per-turn retains from other harnesses.

---

## 2026-05-25 — eager-todo.md prompt lies about `details` field   `[done]` `[high]`

**Where**: `packages/coding-agent/src/prompts/system/eager-todo.md:8`

**Problem**: The injected system reminder told the model to put implementation specifics in a `details` field. `todo_write` `init`/`append` items have always been `array<string>` — `details` only ever lived on long-removed `add_task`/`update` ops. Every eager-todo session triggered a Zod validation error, the model silently retried without `details`, and the planner phase was wasted compute.

**Bug exists identically on `upstream/main` and `v15.2.4`** — not a vacpi regression.

**Fix shipped**: commit `fe7277c09` rewords line 8 to redirect specifics into a follow-up `note` op and explicitly states the string-only constraint.

**Follow-up**: consider upstreaming the patch to `can1357/oh-my-pi` once verified across a few sessions.

---

## 2026-05-26 — Adaptive-thinking max_tokens truncates large structured tool_use calls   `[done]` `[high]`

**Where**: `packages/ai/src/providers/anthropic.ts:1627-1639` (`ensureMaxTokensForThinking`) and `:1884` (`buildParams` default).

**Problem**: `buildParams` defaults `max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0` for every mode. For Opus 4.7 native (`maxTokens: 128_000`) this lands at 42_666; for the GitHub Copilot Opus 4.7 (`maxTokens: 64_000`) it lands at 21_333. Under `effort: xhigh`/`max` the model self-allocates a large thinking burst out of the *same* per-response budget, so a long thinking turn followed by a structured `tool_use` (e.g. a 28-task `todo_write` with file-path-ish strings) can exceed the `/3` cap and Anthropic returns `stop_reason: "max_tokens"`. The harness translates this to `stopReason: "length"`, which is **not** treated as aborted in `agent-loop.ts:533`. The partial tool_use input is then repaired by `parseStreamingJson` (`packages/ai/src/utils/json-parse.ts:142`) — `partialParse` closes dangling braces/quotes at the nearest boundary, so a cutoff right after a comma produces a clean-looking shorter list with no error indication. User sees a silently-truncated todo plan.

**Root cause history**: `ensureMaxTokensForThinking` had an adaptive-mode branch that lifted `max_tokens` to `model.maxTokens` (see git history around `f212cbd8c` and the upstream Sep 2025 commit `35fe8f21e` that originally introduced the `/3` cap). The adaptive branch was deleted in a later consolidation refactor that retained only the budget-mode (`thinking.type === "enabled"`) path. Adaptive (`thinking.type === "adaptive"`, the Opus 4.7+ default) silently fell back to the `/3` default.

**Fix shipped**: restored the adaptive branch in `ensureMaxTokensForThinking` with explicit caller-override respect:

```ts
if (thinking.type === "adaptive") {
    if (callerProvidedMaxTokens) return;
    if (model.maxTokens > 0 && (params.max_tokens ?? 0) < model.maxTokens) {
        params.max_tokens = model.maxTokens;
    }
    return;
}
```

Plus call-site `ensureMaxTokensForThinking(params, model, !!options?.maxTokens)` so the harness only lifts the ceiling when the caller did not specify their own budget. Regression test suite `packages/ai/test/anthropic-adaptive-max-tokens.test.ts` covers four cases: adaptive default (lifts to `model.maxTokens`), adaptive with explicit override (respects caller), adaptive disabled (no lift), budget mode (floor-and-cap invariant preserved).

**Safety analysis** (why "burn the full ceiling" is fine for adaptive):
- Anthropic bills per *actual* tokens used; `max_tokens` is a ceiling, not an allocation. Zero marginal cost.
- TPM rate limits scale to actual usage, not budget.
- `model.maxTokens` IS the documented per-response max for each model — setting `max_tokens` to it is exactly the API contract.
- GitHub Copilot premium budget is per premium-request count, not tokens. No change.
- Per-account soft caps would 400 and route through the existing retry layer.
- Context window pressure: adaptive responses self-regulate and typically land at 5–30K, not the full ceiling. With Opus 4.7's 1M context, the per-response cap doesn't meaningfully change session longevity.

**Why not "raise OUTPUT_FALLBACK_BUFFER"**: my first-pass framing in the original investigation. The 4000 buffer lives in the *budget*-mode path (`thinking.type === "enabled"`), which adaptive Opus 4.7 never enters. Raising it would do nothing for the actual failure mode.

**Follow-up**: `earendil-works/pi` (the true upstream) already shipped a broader version of this fix as `2787b601d` on May 19, 2026. See the "Upstream prefetch from `earendil-works/pi`" section below for the full comparison and reconciliation plan.
---

## 2026-05-26 — Upstream prefetch from `earendil-works/pi` (the real upstream)   `[open]` `[high]`

**Where**: `pi/main` (`earendil-works/pi`), plus secondary survey of `upstream/main` (`can1357/oh-my-pi`) and `upstream/farm/ece8a163/restore-provider-streaming`.

**Correction to my earlier framing**: I initially thought "upstream" meant `can1357/oh-my-pi`. The real source-of-truth upstream is `earendil-works/pi` (the original Pi Agent by Mario Zechner). `oh-my-pi` is can1357's fork. Many "novel" findings in our recent debugging are already shipped — and more cleanly — in `pi/main`. The fix I shipped today (adaptive-only `model.maxTokens` lift) was *independently solved by Mario in May 2026 with a broader sweep*. Acknowledging this and prefetching what's applicable.

### Critical: Mario's token-budget sweep (Apr 29 – May 19) already in `pi/main`, NOT yet in oh-my-pi

A coherent four-commit sequence on `pi/main` by Mario Zechner addresses the exact root cause my fix targets:

| Commit | Date | Title | Net effect |
|---|---|---|---|
| **`83592bb2d`** | Apr 29 | `fix(ai): detect incomplete Anthropic streams` (closes #3936) | Throws if SSE ends without `message_stop` after seeing `message_start`. Exactly the stream-truncation detector that was missing in oh-my-pi. |
| **`5ac874c84`** | May 12 | `fix(coding-agent): retry Anthropic message_stop stream endings` (closes #4433) | Pairs with the detector — coding-agent retries when truncation is thrown. |
| **`22a9c484e`** | May 16 | `fix(ai): respect model output token limits` (closes #4539) | Removes `min(model.maxTokens, 32000)` defensive cap in `buildBaseOptions`. |
| **`6d474f8c1`** | May 17 | `fix(ai): cap context-sized default output budgets` (closes #4614) | Refines: only cap at 32000 when `model.maxTokens >= model.contextWindow - 1024` (i.e. model has no separate output cap). |
| **`2787b601d`** | May 19 | `fix(ai): stop defaulting max token request caps` (closes #4675) | **The big one.** Eliminates `model.maxTokens / 3` divisor in `buildParams`. Changes `options?.maxTokens \|\| (model.maxTokens / 3)` → `options?.maxTokens ?? model.maxTokens`. Adopts `undefined`-means-"no-cap" semantics through `adjustMaxTokensForThinking`. |

The May 19 commit `2787b601d` is **the exact fix we just shipped, but broader** — it applies to ALL modes (budget, adaptive, no-thinking) instead of only adaptive. Mario's diff is also simpler: he just changed the `buildParams` default itself rather than adding a branch in `ensureMaxTokensForThinking`.

### Why our narrower fix is still correct

- `oh-my-pi`'s `anthropic.ts` is **substantially divergent** from `pi`'s. oh-my-pi has the `ensureMaxTokensForThinking` helper, adaptive-vs-budget mode resolution, GitHub Copilot Anthropic OAuth, the `applyCacheControlToLastBlock` machinery, anthropic-adaptive mode flag, etc. Mario's 6-line `buildParams` patch would not apply 1:1 — it would need adaptation to oh-my-pi's flow.
- Our `ensureMaxTokensForThinking` adaptive branch is a localized, tested fix that addresses the same root cause for the model and mode we actually hit.
- Mario's sweep is the upstream-aligned direction. When oh-my-pi pulls these commits, we should reconcile (likely replace our adaptive branch with the broader buildParams change).

### Recommended actions

1. **Keep our adaptive max_tokens fix in place** — already shipped, tested, narrow blast radius.
2. **Prefetch the stream-truncation detector + retry (`83592bb2d` + `5ac874c84`)** — these are directly relevant to the "stuck partial todo_write" symptom the user just experienced. Mario's detector throws on incomplete streams; the coding-agent retries. Both diffs are small (15 + 4 lines), focused, and bring meaningful runtime safety. Adaptation needed: oh-my-pi's Anthropic stream loop is heavily refactored vs pi's `iterateAnthropicEvents`, so this is a port, not a cherry-pick.
3. **Defer Mario's `2787b601d` until oh-my-pi merges it.** The `/3` divisor removal is the right long-term answer but conflicts with our local adaptive-only branch and would change behavior for budget mode + non-thinking mode, which we haven't analyzed yet.
4. **Defer `22a9c484e` + `6d474f8c1`** — same reasoning. These tune `buildBaseOptions` which oh-my-pi structures differently.

### Tier A (oh-my-pi side, defensive, tiny, low-risk) — STILL apply

- **`211a1aa98`** `[high]` Anthropic refusal-fallback error message. 15 lines + 36-line test.
- **`69d73bf84`** `[low]` Trivial type follow-up to `211a1aa98`.

### Tier B — `restore-provider-streaming` branch (`upstream/farm/ece8a163`)

`-994 / +206` lines. Deletes `idle-iterator.ts` entirely. Aligns oh-my-pi with pi's no-watchdog architecture. Not on `upstream/main` yet — watch for merge. Zero conflict with today's adaptive max_tokens fix (touches lines 53, 1089-1116, 1437-1444; our fix at 1627-1660 + 2002).

### Confirmed: no upstream prior art for our specific framing

- Mario's `2787b601d` solves the same root cause but at a different layer (buildParams default vs ensureMaxTokensForThinking branch).
- Our framing — "preserve the budget-mode floor formula AND lift adaptive separately" — is genuinely orthogonal and could be valuable as a *more conservative* alternative to Mario's broader change. Worth offering upstream as a less-invasive option for can1357 to consider.

### Action items

1. ✅ Today's adaptive-max_tokens fix shipped, tested, documented.
2. Port `83592bb2d` (incomplete-stream detector) to oh-my-pi's Anthropic stream loop. Add the retry from `5ac874c84` to the coding-agent. This directly addresses the "stuck partial" symptom and is a defensive win independent of any token-budget question.
3. Cherry-pick `211a1aa98` + `69d73bf84` from `upstream/main`.
4. Add `pi/main` token-budget sweep (`22a9c484e`, `6d474f8c1`, `2787b601d`) to the "watch-and-reconcile when oh-my-pi merges" list.
5. Watch `upstream/farm/ece8a163/restore-provider-streaming` for merge to `upstream/main`.
6. Optional: open an upstream PR against `can1357/oh-my-pi:main` with our adaptive-only fix + regression test as a narrower alternative to Mario's `2787b601d`. Let can1357 decide which direction to take.

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
## 2026-05-25 — Hindsight `recall` / `retain` tools don't surface tag filters   `[done]` `[high]`

**Where**: `packages/coding-agent/src/tools/memory-recall.ts:8-13`, `packages/coding-agent/src/tools/memory-retain.ts:6-16`, `packages/coding-agent/src/hindsight/state.ts:26-35`.

**Problem**: Model-facing schemas are minimal:
- `recall`: `{query: string}` only
- `retain`: `{items: [{content, context?}]}`

The internal `HindsightApi` already supports the full Hindsight feature set per `client.ts:97-104` (`RecallOptions { types, maxTokens, budget, tags, tagsMatch }`) and `MemoryItemInput` accepts tags + metadata + types. Hindsight MCP exposes tag-filtered recall as a first-class feature. We are silently dropping the precision-recall benefit.

**Cost of fix**: ~30 input tokens added to `recall` description, ~20 to `retain`. Two-file Zod schema extension + pass-through to existing client calls. Fully testable. **Fix shipped**: `recall` now accepts optional `tags` + `tagsMatch`, merges caller tags with session scope tags, and forwards them to `HindsightApi.recall`; `retain.items[]` now accepts optional `tags`, merges them with session retain tags, and flushes them through the existing retain batch queue. Regression coverage lives in `packages/coding-agent/test/memory-tools.test.ts`.

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

## 2026-06-01 — Live session observability and browser-backed TUI debugging   `[open]` `[high]`

**Where**: `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/session-manager.ts`, `packages/coding-agent/src/modes`, `packages/coding-agent/src/commands`, possible new `sessions` command and local dev server.

**Validated current state**:

- `AgentSession.subscribe(...)` exists and emits rich in-process events, but only inside the owning `omp` process.
- `/session` exposes current-session stats, but only from inside the active TUI.
- `SessionManager.list(...)` powers resume/session selection over persisted files, not live running processes.
- ACP/RPC modes provide protocol-level observability only for sessions launched under those modes. A normal interactive `omp update` session is not attachable.
- `omp stats` is historical/local observability, not a live watch API.
- Root, `packages/coding-agent`, and `packages/tui` already depend on `@xterm/headless`, so terminal-state modeling is not foreign to the repo.
- No native surfaces found for `omp sessions list --running`, `omp sessions watch <id>`, read-only attach, or an agent tool that inspects active `omp` sessions.

**Problem**: OMP is strong at developing and debugging web apps because the agent can use browser tooling against a visible running app. TUI work lacks the same feedback loop. Today, debugging a live `omp` session requires terminal automation (`tui-use`) or reading persisted logs/session files. That is useful, but it is not a first-class OMP API, and it does not let an agent inspect or visually debug another running TUI session the way it can inspect a browser app.

**Recommended approach**:

1. **Runtime session registry**: each top-level `omp` process writes `~/.omp/agent/runs/<session-id>.json` with `pid`, `cwd`, `sessionFile`, `command`, `mode`, `model`, `startedAt`, `lastHeartbeat`, `status`, and `title`. Heartbeat atomically refreshes while alive; stale PID entries are marked dead by readers.

2. **Live event stream**: mirror selected `AgentSessionEvent` records to `~/.omp/agent/runs/<session-id>.events.jsonl`. Include turn start/end, model changes, tool start/end, todo state, async-job snapshots, MCP connect errors, update/merge/build phases, and final error. Keep payloads bounded and redacted using the same TUI sanitization helpers.

3. **CLI and tool surface**:
   - `omp sessions list --running --json`
   - `omp sessions inspect <id> --json`
   - `omp sessions watch <id> [--json]`
   - model-facing tool `omp_sessions` with `list`, `inspect`, and `watch_snapshot`
   - first narrow use case: `omp sessions watch latest` for `omp update`, including merge phase plus `.git/omp-rebuild.log` status.

4. **Browser-backed TUI mirror**: add a local dev server that exposes a read-only terminal mirror over WebSocket or SSE. The browser tool can then inspect screenshots, accessibility tree, DOM state, and visual regressions for TUI sessions, matching the workflow OMP already supports for web apps.

**xterm.js option**: `xterm.js` is mature, MIT-licensed, TypeScript, and used by VS Code, Hyper, Tabby, ttyd, and similar tools. It supports real terminal apps, mouse events, WebGL rendering, addons, and `@xterm/headless` for server-side terminal state plus serialization. It is the conservative choice for a reliable visual TUI mirror. OMP already has `@xterm/headless`, which makes the first slice cheaper: feed PTY output into a headless terminal state, serialize snapshots, then later add a browser renderer with `@xterm/xterm` plus `@xterm/addon-fit` and optionally `@xterm/addon-serialize`.

**wterm option**: `vercel-labs/wterm` is a newer Apache-2.0 web terminal with DOM rendering, native text selection, browser find, accessibility, dirty-row rendering, WebSocket transport, and optional Ghostty/libghostty-backed VT emulation. It is attractive for visual debugging because DOM rows are directly inspectable by browser tools. Risk is maturity and integration surface compared with xterm.js. Prototype it as an experimental renderer, not the default.

**Suggested architecture**:

- Use the existing PTY/TUI boundary as the capture point, not screen scraping.
- For read-only watch, tee output bytes into a terminal-state engine and expose snapshots/events. Do not allow input at first.
- For browser visual debugging, serve `/sessions/:id/terminal` with a renderer plus `/sessions/:id/events`.
- Add a browser-tool-friendly metadata panel: current model, turn state, active tool, selected session file, cwd, tokens, and last error.
- Later add controlled input/attach only after permissions are explicit. Read-only first avoids accidental interference with a running agent.

**Why not only `tui-use`**: `tui-use` is excellent external automation, but it is terminal-screen-level. OMP-native observability can expose structured session identity, model/tool phases, event history, and bounded snapshots without requiring the observer to own the process terminal. The right design is a native session watch API plus optional browser terminal mirror.

**Follow-up**: implement the registry + `omp sessions list --running --json` first. Then wire event snapshots from `AgentSession.subscribe`. Only after the structured API exists should we prototype xterm.js or wterm rendering.
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

---

## 2026-06-02 — Async "ultra oracle": orchestrated context prep + ultra-tier oneshot (browser-engine-first)   `[open]` `[high]`

**Where**: new async agent `packages/coding-agent/src/prompts/agents/ultra-oracle.md` registered in `packages/coding-agent/src/task/agents.ts:44-72`; new `ultra` model role in `packages/coding-agent/src/config/model-registry.ts:95,114` (plumbing at `settings-schema.ts:213`, `model-resolver.ts:546`); reuses the existing async dispatch unchanged (`packages/coding-agent/src/task/index.ts:303-320`) and the existing CDP browser substrate (`packages/coding-agent/src/tools/browser/registry.ts:9-151`, `browser/attach.ts`). API fallback extends the toolless `llm()` bridge (`packages/coding-agent/src/eval/llm-bridge.ts:30-40`). Prior art: `skill://oracle` (the `@steipete/oracle` CLI) and RepoPrompt `context_builder` (MCP).

**Context**: Consult an ultra-tier model for the hardest questions. The target the user actually wants is the **no-API-cost path**: their signed-in ChatGPT GPT-5.x Pro session, driven by browser automation. These runs are slow (5-30 min typical, 60+ min worst case) and chat-context-only (one self-contained prompt in, one answer out, no tool loop). The main agent must not spend its turn assembling the prompt or block on the answer: a cheap orchestrator prepares the context (the way RepoPrompt context_builder does) and hands a tight bundle to the driver, and the result returns async via `<task-notification>`. The API engine is a generic option for users without a Pro browser session, not the primary path here.

### Why the current `oracle` does not cover this

`oracle` (`prompts/agents/oracle.md`) is `model: pi/slow`, `blocking: true`, full tools, agentic loop. `blocking: true` forces the synchronous in-process path (`task/index.ts:305`), correct for `pi/slow` (seconds to a couple minutes) but wrong for a 60-minute run. Ultra chat models do not run tool loops. There is also no `ultra`/`pro` role: `MODEL_ROLE_IDS` stops at `slow` (`model-registry.ts:114`).

### The real deliverable is the integration layer, not the automation

The hard, change-prone part (driving a logged-in ChatGPT GPT-5.x Pro chat: submit, detect a 5-60 min completion, extract, reattach) can lean on a driver. The oh-my-vacpi-native piece worth building well is the **context-transmission + result-collection layer**:
- a cheap orchestrator agent (`pi/smol`) that assembles the `skill://oracle` "exhaustive prompt" bundle (briefing, where-things-live, exact question with verbatim errors and what was tried, constraints, desired output, fewest files that hold the truth) under a token budget;
- an async job that hands the bundle to the selected driver and collects the answer without blocking the main agent;
- a small `UltraDriver` interface (`submit(bundle) -> handle`, `poll(handle) -> pending | done(answer)`, `reattach(handle)`) so the driver is pluggable and a long run survives an omp restart.

### Driver options (we already own most of the substrate)

oh-my-vacpi already ships the CDP plumbing Oracle reimplements: `browser/registry.ts` supports `headless`, `spawned` (launch a real browser binary with extra args plus `--remote-debugging-port`, and **reuse an existing CDP endpoint** via `findReusableCdp`), and `connected` (attach to a running CDP URL) modes, all over `puppeteer-core`. A native driver is therefore cheap.

1. **Our own CDP driver (default, recommended)**: point the `spawned`/`connected` modes at the user's signed-in Chrome (either spawn Chrome with `app.args: ["--user-data-dir=<profile>", "--remote-debugging-port=…"]`, or attach to a Chrome the user already launched with remote debugging). A scripted flow then drives chatgpt.com: select GPT-5.x Pro, paste the bundle, submit, poll for completion, extract the final message. Auth-reuse caveat: Chrome locks the live default profile, so use a dedicated automation `--user-data-dir`, or extract and inject cookies (Oracle's `sweet-cookie` approach) into that profile. No API cost, no new dependency, fully in-process.
2. **Oracle CLI subprocess (borrow, out-of-process)**: shell `npx -y @steipete/oracle --engine browser --model gpt-5.x-pro --slug "<3-5 words>" -p "<bundle>" --file …`. It already solves completion-detection and persists reattachable sessions under `~/.oracle/sessions` (`oracle session <id> --render`). Heavy dep tree, but out-of-process so it never enters our bundle or `--compile` binary. Useful as the reattach backbone while the native driver matures.
3. **Third-party browser-automation tool (only if DOM drift demands self-healing)**: Stagehand (TypeScript, Browserbase) mixes scripted and AI actions and fits a TS codebase; `browser-use` (Python) is an LLM agent that re-derives navigation each step. For a fixed flow (open, select model, paste, wait, copy) a scripted driver is more reliable, free, and deterministic; an LLM-driven agent self-heals against ChatGPT redesigns but costs its own tokens and is nondeterministic. Recommend scripted-first and keep an LLM-agent path only as a self-healing fallback if selector breakage becomes frequent. All slot behind the same `UltraDriver` interface.

### Recommended v0 / v1 / v2

- **v0 (no-API-cost browser engine, our own CDP driver)**: `ultra_oracle` agent on `pi/smol` (orchestrator, `blocking: false`) plus the `UltraDriver` interface plus the native CDP driver against a signed-in ChatGPT GPT-5.x Pro profile. The orchestrator assembles the bundle, the async job drives the browser and collects the answer. This is the user's primary path.
- **v1 (durable reattach + API fallback)**: add reattach-across-restart (native driver persists its CDP/session handle, or shell the Oracle CLI as the reattach backbone), and wire the generic API engine behind the same `ultra` role plus an `ultra` tier on `llm()` for users without a Pro browser session.
- **v2 (self-healing driver, only if needed)**: add a Stagehand or LLM-agent driver behind `UltraDriver` as a fallback when scripted selectors break on a ChatGPT redesign.

### Cost and safety guards

- Gate behind `ultraOracle.enabled` (default off) plus `async.enabled`. The browser path has no API cost but still ties up a Chrome session for up to an hour.
- Orchestrator enforces a token budget before sending (oracle skill targets under ~196k input). Never attach secrets (`.env`, key files).
- Drive a dedicated automation profile, never the user's live default session, to avoid disrupting their logged-in browser. Surface ultra runs in `/usage` and `omp stats` (count as runs on the browser path, not premium requests).

### Why not <alternatives>

- **Why not API-first**: the user wants the no-API-cost Pro browser session; API is the generic fallback for others.
- **Why not vendor Oracle's library**: it has none (CLI + MCP only, no `exports` map); the dep tree is too heavy for our Bun `--compile` bundle. Borrow it out-of-process if at all.
- **Why not browser-use as the default driver**: it is an LLM agent that re-derives a fixed flow nondeterministically and burns tokens; a scripted CDP driver on our existing substrate is cheaper and more reliable for this known UI.
- **Why not make `oracle` async**: it is intentionally inline and tool-driven for `pi/slow`; flipping `blocking` regresses the fast-consult case and leaves the chat-only and orchestration gaps.
- **Why not have the main agent assemble the bundle**: that is the time waste the request calls out; the orchestrator runs on a cheap model off the main loop.

**Follow-up**: ship v0 (native CDP driver against signed-in GPT-5.x Pro) first behind `ultraOracle.enabled`; add reattach plus API fallback in v1; add a self-healing driver in v2 only if selector breakage proves frequent.

---

## 2026-06-02 — eager-todo forced first call double-wraps `ops` under tool_choice   `[done]` `[high]`

**Where**: `packages/coding-agent/src/prompts/system/eager-todo.md:11-13`, regression in `packages/coding-agent/test/agent-session-eager-todo.test.ts:204-220`.

**Problem**: A third, distinct failure of the eager-todo forced first call, observed live this session. After the `details` hallucination (`[done]`, 2026-05-25) and the empty `todo_write({})` case (`[done]`, 2026-05-26), the reminder still induced a double-wrap: the model emitted `{"ops":{"ops":[…]}}`, which fails Zod as `ops: Invalid input: expected array, received object`. This differs from the empty case (`expected array, received undefined`): here `ops` is present but is an object, not the array.

**Root cause**: line 11 said "keep the `ops` wrapper" and line 12 showed the full arguments object `{"ops":[…]}`. Under forced `tool_choice: { type: "tool", name: "todo_write" }` (`utils/tool-choice.ts`), the model emits the tool *arguments*. "keep the `ops` wrapper" reads as "wrap your list in an `ops` object", so the model puts `{"ops":[…]}` as the value of the `ops` argument, producing `{"ops":{"ops":[…]}}`. The literal-example anchor that fixed the empty-`{}` case introduced this new ambiguity.

**Fix shipped**: reworded line 11 to state `ops` is the single top-level argument whose value is the array shown, with an explicit "do not nest another `ops` inside it"; added line 13 naming the failure (`a value like { "ops": { "ops": … } }` is rejected as `ops: expected array, received object`). Extended the regression test to assert the anchored example is a flat `ops` array (`Array.isArray(parsed.ops)`, `parsed.ops[0]` has no nested `ops`) and that the reminder names the double-wrap failure (`received object`). Verified: `bun test test/agent-session-eager-todo.test.ts` reports 6 pass.

**Not addressed (out of scope, not a prompt bug)**: the first `todo_write` this session failed with "Request was aborted", a transient runtime abort unrelated to payload shape. No prompt change fixes that; it routes through the normal abort/retry path.

**Why not auto-recover server-side**: same reasoning as the empty-`{}` entry (2026-05-26): unwrapping `{"ops":{"ops":…}}` in the tool dispatcher couples validation to prompt heuristics. The prompt anchor fixes every forced-tool-choice surface for every model at zero runtime cost.

**Follow-up**: if the literal-example anchor was upstreamed to `can1357/oh-my-pi`, it carries the same ambiguity; upstream the reword plus the test hardening alongside the prior two eager-todo fixes.

---

## 2026-06-05 — Agent-facing harness observability tools/API   `[open]` `[high]`

**Where**: new tool(s) under `packages/coding-agent/src/tools/`, backed by a read-only introspection surface over system-prompt assembly (`system-prompt.ts`), session state (`session/agent-session.ts`), settings resolution (`config/`), and capability discovery (`discovery/`). Related: the 2026-06-01 "Live session observability" entry (that one observes a running session from outside; this one lets the agent introspect harness internals from inside).

**Context**: The agent has no first-class way to understand the harness it runs in. Questions like "is the global AGENTS.md loaded", "what is my exact context composition", "which providers/capabilities resolved" currently require ad-hoc `bun run` probes against the source. User wants the agent to answer harness questions from inside a session. Stated as a near-term plan: expose the API first, then the tools.

**Recommendation (not implemented)**: Build one read-only introspection API (context composition, resolved settings, active tools/skills/rules, capability results, token accounting) as the single source of truth, then surface it to both the user-facing context inspector (below) and a model-facing tool. Avoid two divergent code paths. The model-facing tool is LOW priority per user (2026-06-05): a brief "see the API docs" hint suffices and the model can search docs; the read-only data model/API is the high-priority foundation.

---

## 2026-06-05 — In-session context inspector: byte-for-byte expandable manifest   `[in-progress]` `[high]`

**Where**: `/context` command in `modes/controllers/command-controller.ts:587`, renderer `modes/utils/context-usage.ts`, system-prompt assembly `system-prompt.ts` (`buildSystemPrompt`), message state `session/agent-session.ts`. Token accounting already exists (`pi-natives` `countTokens`, compaction `estimateTokens`).

**Context**: Current `/context` shows a token-category summary (System prompt / tools / context / Skills / Messages / Free / Autocompact buffer). Good for "what roughly fills the window", useless for "show me exactly what the model sees". User wants a progressive, byte-for-byte drill-down from the system prompt through every message to the latest, modeled as a recursive expand/collapse manifest (HTML `<details>`/`<summary>` mental model): a top node with a one-line summary plus token/byte count, expandable into children (system blocks -> sections -> context files / skills / tools; messages -> each message -> full content), collapsible back to a tag.

**Recommendation (decisions 2026-06-05)**: TUI-native first; browser HTML is a later "plus" (user barely uses the browser). Save as hybrid with TUI priority. Surface as `context full` / `context detailed` (NOT "manifest" — too obscure for users): either a typed arg on `/context`, or `/context` made interactive (arrow keys to drill in). Auto-expand to a "nice" default level (System prompt -> block 1 / block 2, top-level categories, as in the proposed tree); full byte-for-byte content is NOT auto-expanded but user-triggered, with smooth back-and-forth navigation to trace where each piece of context comes from. Secrets shown RAW in the inspector (user owns them; LLM-facing masking is the separate secret-redaction entry below). Per-node token/byte/% from existing accounting. Thinking-block handling in any HTML view deferred.

---

## 2026-06-05 — Agent-visible TUI screenshot (self-view rendered into chat)   `[open]` `[high]`

**Where**: `tui_observe` (`screenshot` / `native_screenshot` actions), the browser-mirror render pipeline, and the tool-result image attachment path. Related: 2026-06-01 "Live session observability" entry.

**Context**: When the agent drives a browser, the screenshot is attached and the user sees exactly what the agent saw. User wants the same for the TUI: the agent renders the running terminal (loopback mirror or native capture), screenshots it, and the image surfaces in the user's chat so the user can confirm the agent sees the terminal correctly. `tui_observe screenshot` already renders via the mirror and `native_screenshot` exists, but it is unverified whether the resulting image surfaces inline in the user-visible transcript the way browser screenshots do.

**Recommendation (not implemented)**: Verify the `tui_observe screenshot` image attaches to the user-visible transcript (not just returned to the model); if not, route it through the same attachment path the browser tool uses. Capturing the agent's own live session mid-render is reflexive, so a separate process/session is likely needed for a clean shot.

---

## 2026-06-05 — Parallel background compaction via cheap SMOL model   `[open]` `[high]`

**Where**: compaction pipeline (`@oh-my-pi/pi-agent-core/compaction`, `session/agent-session.ts` compaction paths), model roles (`config/model-registry.ts` smol/slow), async dispatch (`task/index.ts`), tool-output truncation (vacpi already truncates tool I/O and saves the full output).

**Context**: User has a cheap fast SMOL model on Fireworks.ai with generous (near-unlimited) rate limits, target Kimi 2.6 Turbo (256K context). Idea: run a compaction/summarization agent continuously IN PARALLEL in the background, maintaining a precomputed compacted summary of the live session, so when the user or model wants to compact or hand off, the compacted context is ALREADY ready (instant swap). Show in the TUI that the context was swapped to the auto-compacted version.

Key requirements:
- Cadence: not every agent response / user input (too frequent); something like every ~5 events / debounced. Open question.
- Preserve the system prompt BYTE-FOR-BYTE identical; only summarize messages. The agent is a "smart context manager" that knows what to keep verbatim vs compress.
- Tool-output preservation: keep tool/file references with a legend/caption (e.g. "calls X,Y read file Z; result elided, may matter") so the agent does not need to re-run the tool to recover output. vacpi already saves full outputs; the captions are continuation hints to avoid wasted re-runs.
- Iterative for huge sessions: the cheap model's 256K window is smaller than Opus/GPT 1M. For sessions exceeding it, compact iteratively from session start, feeding the model its own prior summary plus the next slice of messages, folding forward. Target keep under ~200K.
- Feedback loop: if the user or agent judges a compaction bad, capture it to improve the compaction agent/prompt over time.

**Recommendation (not implemented, design pending)**: Hybrid summary = deterministic skeleton (system prompt verbatim, tool-call reference captions templated, message boundaries) + model-written prose for the semantic part. Background worker on the smol role; write the rolling summary ALONGSIDE the session (not into it) so the live session is untouched until an explicit swap. Reuse existing compaction token accounting. Shares its summary artifact with the auto-handoff entry below.

---

## 2026-06-05 — Extend `/handoff`: agent-initiated trigger + literal-summary seed   `[open]` `[med]`

**Where**: existing `/handoff` command (`slash-commands/builtin-registry.ts:849`, `allowArgs: true`, `inlineHint: "[focus instructions]"`) -> `command-controller.ts:1230 handleHandoffCommand` -> `agent-session.ts:6094 session.handoff` -> `generateHandoff` (oneshot LLM over full history). Session creation via `session-manager.ts`.

**Finding (2026-06-05)**: `/handoff [focus instructions]` ALREADY exists and does most of the vision: it takes a focus arg, the handoff document is LLM-generated by `generateHandoff` (steered by the focus text, `initiatorOverride: "agent"`, honors the `/model` thinking level), and it seeds a new session. So "the agent creates the summary" is already true; the focus arg steers it (it is NOT a verbatim summary you paste).

**Gaps (what is left to add)**: (1) Agent-initiated handoff: `/handoff` is user-typed only; there is no model-facing tool/trigger, so the agent cannot propose or run a handoff itself when context bloats. (2) Literal-summary injection: handoff always regenerates from history + focus; there is no path to pass an exact pre-written document. This is where the parallel-compaction rolling summary would plug in as the handoff seed.

**Recommendation (not implemented)**: Keep `generateHandoff` as the default. Add (a) an optional model-facing trigger (tool or threshold-gated proposal), gated + reversible (preserve parent, link via `parentSession`); and (b) an option to seed the handoff from a supplied summary (the rolling compaction artifact) instead of regenerating. One summary generator, two consumers (in-place compaction swap + handoff).

---

## 2026-06-05 — Secret redaction: identity-preserving masking + raw in user inspector   `[open]` `[med]`

**Where**: secret obfuscation path (`secretsEnabled` in `system-prompt.ts` `buildSystemPrompt`, plus the `#XXXX#` redaction applied to tool output), and the context inspector above.

**Context**: omp already masks secrets to the model as `#XXXX#` opaque tokens. User's requirements: (1) confirm secrets are ALWAYS masked before reaching the LLM (the agent never sees raw values); (2) masking must be IDENTITY-PRESERVING, the same secret maps to the same token so the model can tell whether two secrets are equal without seeing values (e.g. compare two API keys); (3) the model should KNOW a token is a redacted secret so it does not falsely tell the user to rotate an "exposed" key; (4) the USER-facing context inspector shows secrets RAW (the user owns them on their own machine). Net: the model can manipulate secrets via tools and reason about their identity, but never sees the values.

**Recommendation (not implemented, verify first)**: Audit the existing redaction to confirm it is consistent/identity-preserving (same input -> same token) and that the model is told the token semantics. Then ensure the inspector renders raw (unredacted) since it is user-facing.

---

## 2026-06-05 — Debug/ephemeral session class (exclude from resume + recent lists)   `[open]` `[med]`

**Where**: session creation (`session/session-manager.ts`), the run registry under `~/.omp/agent/runs`, the resume/recent pickers (`modes/controllers/selector-controller.ts` session selector + the recent-session listing), and `tui_observe list`.

**Context**: To verify TUI work (e.g. drive `/context full` and screenshot it through the loopback mirror), the agent spawns a throwaway `omp` session in tmux. That session persists like any real one and pollutes the user's resume/recent list, so genuine sessions get buried under debugging spawns. Today the only way to find a real session is to scroll past the test ones. Verified live on 2026-06-05: spawning a test session works (tmux + `omp` source-run + `tui_observe screenshot`/`snapshot`), but it lands in the normal session history.

**Recommendation (not implemented)**: Add a session "kind" flag (`debug`/`ephemeral`) settable at launch (a CLI flag like `omp --ephemeral`, or an env var), recorded in the run registry and the session storage metadata. The resume/recent pickers filter these out by default, with an explicit toggle/filter ("show debug sessions") to surface them; optionally TTL-prune ephemeral session files after N days. This lets the agent spin up clean test sessions for TUI screenshot verification (which needs a separate process from the live session for a non-reflexive shot) without polluting the user's history. Pairs with the "Agent-visible TUI screenshot" entry above, which already depends on a separate session for a clean capture.

---
## 2026-06-05 — TUI overlay/streaming flicker: pull upstream v15.9.2/v15.9.3 scrollback fixes   `[done]` `[high]`

**Where**: TUI render-intent + native scrollback (`packages/tui/src/tui.ts`), the fork patch `ad5399a01` (`tui.rebuildScrollbackDuringStreaming` opt-in) and `EventController.setEagerNativeScrollbackRebuild`. Symptom surfaced via the `/context full` inspector but is not inspector-specific.

**Finding (2026-06-05, confirmed by frame analysis of a Warp screen recording)**: The overlay (and likely streaming responses) flicker as a "compressed/half-rendered duplicate strip of the first rows at the very top," with orphaned right-aligned metrics, sitting above a clean copy. That is scrollback duplication / transient overlay rows, NOT the inspector's own render. Our tree is at the v15.9.1 merge base (`be70b0c52`); upstream shipped a series of TUI scrollback/overlay fixes in v15.9.2 and v15.9.3 that directly target this, NONE yet in our tree:
- `5e369d4fc` prevented hidden overlays leaving transient rows in scrollback
- `9f895141f` / `744708618` prevented live-region collapse duplicating scrollback
- `f75cb3d41` dropped eager rebuild mode immediately when stream settled
- `61f11a6ce` blocked destructive scrollback replay on unknown terminal viewports (the user runs under remote-control = an "unknown viewport")
- `689431f17`, `1e3a8d5cd`, `d719e0791`, `4e54836f9`, `a1da2a8f0`, `f863d98f5` (related live-region/scrollback pins since v15.9.1)

**Interaction with the fork patch**: `ad5399a01` made the eager native scrollback rebuild opt-in (default OFF) so the TUI stops auto-following scroll to the bottom (lets the user keep reading a long message while scrolled up). Disabling that rebuild can leave the transient/duplicate overlay rows the rebuild would otherwise clear, so the fork patch likely AGGRAVATES the flicker. Upstream `f75cb3d41` ("dropped eager rebuild mode immediately when stream settled") is a more surgical take on the same code path.

**Recommendation (not implemented; merge work, user-owned)**: On the next upstream merge (v15.9.1 -> v15.9.3), prioritize these TUI commits and verify the overlay flicker AND the "don't follow scroll" behavior together; re-evaluate whether `ad5399a01`'s blanket opt-in is still needed or should be replaced by upstream's eager-rebuild rework (preserve the no-auto-scroll behavior the user wants). The context inspector overlay was independently hardened (top-anchored, header pinned, fixed-viewport internal scroll) to minimize the height-churn that triggers the bug, but the root fix is upstream.

**Update (2026-06-06, v15.10.0 merge):** Merge work landed. The four flagged scrollback/overlay commits I verified (`5e369d4fc`, `9f895141f`, `f75cb3d41`, `61f11a6ce`) plus the related live-region pins are now ancestors of `main` (carried in via the v15.9.x merges), and the v15.10.0 merge added upstream's DEC 2026 synchronized-output default rework and the WSL/Windows Terminal row-flicker fix ([#2011](https://github.com/can1357/oh-my-pi/issues/2011)). The fork's Warp sync opt-in survived the merge: upstream rewrote `shouldEnableSynchronizedOutputByDefault` (dropped the `platform` param, replaced the `termProgram` switch with a `terminalId` switch), so the Warp opt-in is now a case-insensitive `TERM_PROGRAM=WarpTerminal` guard, covered by the `terminal-capabilities.test.ts` Warp test. Still user-owned: confirm the overlay/streaming flicker is actually gone in Warp, and decide whether `ad5399a01`'s `tui.rebuildScrollbackDuringStreaming` blanket opt-in (default off, preserves the no-auto-scroll behavior) is still needed now that upstream's eager-rebuild rework (`f75cb3d41`) is in tree.

---
