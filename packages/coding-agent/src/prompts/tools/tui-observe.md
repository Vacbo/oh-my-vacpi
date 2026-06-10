Inspect live OMP terminal sessions: their structured DOM-like terminal state and, on request, a screenshot photo of what the user sees.

Use this to observe a running OMP session (the current one, or another launched via bash) when you need to reason about or debug its on-screen TUI state.

## Actions

- `list` — list live OMP sessions (registry-backed and detected processes). Pass `running: true` to hide stopped/stale ones.
- `snapshot` (default) — return a session's metadata plus its current terminal snapshot: dimensions, cursor, visible text, and per-cell rows. Defaults to the current session when `run` is omitted.
- `events` — return recent sanitized session events (bounded by `limit`).
- `mirror` — start (or report) the loopback browser mirror URL for a run. The mirror exposes stable DOM selectors (`[data-terminal-snapshot]`, `[data-terminal-row]`, `[data-terminal-cell]`, `[data-cursor]`) and a live SSE stream.
- `screenshot` — render the run's terminal through the loopback mirror and save a PNG. Returns the snapshot plus the screenshot path and image. Requires the headless browser.
- `native_screenshot` — photograph the actual terminal window via OS tools (macOS `screencapture`, Linux `grim`/`maim`/`import`). Disabled by default; enable `tui.nativeCapture.enabled`. Never falls back to a full-screen capture; returns a typed failure when no specific window can be resolved. The result attaches a downscaled preview that also renders in the session, so the user sees the same capture; the summary keeps the full-resolution path for `inspect_image`.
- `emulator_screen` — read the text the terminal emulator actually rendered for the run's surface (requires the session to run inside cmux; the surface id is recorded when the session starts).
- `render_diff` — compare the internal snapshot (what the renderer believes it drew) against the emulator's rendered text, row by row. A mismatched row localizes a rendering bug: the row was either emitted wrong by the TUI or interpreted differently by the terminal.

## Parameters

- `run` — run id from `list`. Optional; defaults to the current session, or the only running session when unambiguous.
- `limit` — for `events`, the maximum number of recent records to return; for `emulator_screen`, only the last N lines (includes scrollback).
- `running` — for `list`, only include running sessions.

## Notes

- Structured snapshots are always available for registry-backed sessions. Process-only sessions (detected from `ps`) have no event stream or terminal snapshot.
- Choosing a backend: text first, pixels only when text cannot answer. `snapshot`, `emulator_screen`, and `render_diff` are cheap and diffable — use them for layout, content, wrap, cursor, and stale-row checks. Text grids cannot show inline images (Kitty/iTerm2/Sixel render as blank or placeholder cells), font/glyph problems, or actual colors — verify those with `screenshot`/`native_screenshot` and inspect the image.
- `render_diff` compares a periodically persisted snapshot against the live screen. The captures are not simultaneous: a busy session often scrolls in between, which is reported as a non-zero `scrollOffset` (with only the overlap compared) rather than as mismatches. `scrollOffset != 0` with few mismatches means the screens agree and only the timing differed; check `internal.ageMs` and re-run once the target settles before trusting a non-empty diff.
- `tui_observe` is read-only — to spawn a TUI under test and send it input (then screenshot or diff it), use `tui_drive`.
