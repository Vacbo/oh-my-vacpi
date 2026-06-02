Inspect live OMP terminal sessions: their structured DOM-like terminal state and, on request, a screenshot photo of what the user sees.

Use this to observe a running OMP session (the current one, or another launched via bash) when you need to reason about or debug its on-screen TUI state.

## Actions

- `list` — list live OMP sessions (registry-backed and detected processes). Pass `running: true` to hide stopped/stale ones.
- `snapshot` (default) — return a session's metadata plus its current terminal snapshot: dimensions, cursor, visible text, and per-cell rows. Defaults to the current session when `run` is omitted.
- `events` — return recent sanitized session events (bounded by `limit`).
- `mirror` — start (or report) the loopback browser mirror URL for a run. The mirror exposes stable DOM selectors (`[data-terminal-snapshot]`, `[data-terminal-row]`, `[data-terminal-cell]`, `[data-cursor]`) and a live SSE stream.
- `screenshot` — render the run's terminal through the loopback mirror and save a PNG. Returns the snapshot plus the screenshot path and image. Requires the headless browser.
- `native_screenshot` — photograph the actual terminal window via OS tools (macOS `screencapture`, Linux `grim`/`maim`/`import`). Disabled by default; enable `tui.nativeCapture.enabled`. Never falls back to a full-screen capture; returns a typed failure when no specific window can be resolved.

## Parameters

- `run` — run id from `list`. Optional; defaults to the current session, or the only running session when unambiguous.
- `limit` — for `events`, the maximum number of recent records to return.
- `running` — for `list`, only include running sessions.

## Notes

- Structured snapshots are always available for registry-backed sessions. Process-only sessions (detected from `ps`) have no event stream or terminal snapshot.
- Prefer `snapshot`/`mirror` (structured DOM) for reasoning and control; use `screenshot`/`native_screenshot` when you need pixel fidelity of what the user sees.
