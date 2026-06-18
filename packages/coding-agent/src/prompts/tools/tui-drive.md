Drive TUI programs in a real PTY: spawn a command, type text, send keys, wait for the screen to settle, and read back what the terminal rendered.

Use this to test the omp TUI itself (or any terminal program) end to end — the input-injection counterpart to the read-only `tui_observe`. To test working-tree TUI changes, start `bun <repoRoot>/packages/coding-agent/src/cli.ts`; to test the installed build, start `omp`.

## Actions

- `start` — spawn `command` in a fresh PTY (`cwd` defaults to the agent's). Returns the session id and the screen after output settles. Sessions persist across tool calls; at most 4 concurrently. Pass `record: true` to capture the session to an asciicast v2 `.cast` file (custom destination via `castPath`).
- `input` — send `text` (literal typing; each `"\n"` is sent as Enter) and/or `keys` (named keys, sent after the text). Returns the settled screen.
- `wait` — wait for `waitText` (a regex matched against the rendered screen) or, without it, for output to go idle. Returns the screen plus a `timedOut` flag; a timeout is not an error.
- `screen` (default) — return the current emulator screen: status, dimensions, cursor, and visible text.
- `scrollback` — return the full output tape (scrollback plus screen) as logical lines, wrapped rows joined. Use it to assert against content that scrolled out of the window, e.g. "this box was committed exactly once". `limit` caps the returned tail (default 200 lines); `totalLines` reports the whole tape.
- `screenshot` — styled PNG of a **driven omp session** via the loopback mirror (requires the spawned command to be omp; needs the headless browser). The image is attached to the result.
- `diff` — compare the driven omp child's internal renderer snapshot against this PTY's emulator screen, row by row (requires the spawned command to be omp). Localizes rendering bugs without cmux.
- `resize` — resize the PTY and emulator to `cols` × `rows`, then return the settled screen.
- `kill` — terminate a running session (returns the final screen and exit info, keeping the record for post-mortem), or remove an already-exited record.
- `list` — list drive sessions with status and correlated omp run ids.
- `cast` — read back a recorded session (requires `record: true` at `start`), or any `.cast` file via `castPath` (e.g. after `kill`). Returns the asciicast summary (dimensions, duration, event count, output bytes) plus reconstructed screen text: the final frame by default, `frames` frames sampled evenly across the recording, or a single frame at `at` seconds. With `render: true`, also writes an animated GIF via the optional `agg` binary.

## Parameters

- `session` — drive session id. Optional; defaults to the only live session.
- `command`, `cwd`, `env`, `cols`, `rows` — for `start` (`command` required; 120×35 default). `cols`/`rows` are required for `resize`. Caller `env` entries win over the spawn defaults.
- `record`, `castPath` — for `start`: `record: true` records the PTY to an asciicast v2 `.cast` file; `castPath` sets the destination (its parent dir is auto-created), otherwise a temp file is used.
- `text`, `keys` — for `input`. Key names follow the pi-tui grammar: `enter`, `escape`, `tab`, `space`, `backspace`, `delete`, `up`/`down`/`left`/`right`, `home`/`end`, `pageUp`/`pageDown`, `f1`–`f12`, and `ctrl+`/`shift+`/`alt+` combinations (`ctrl+c`, `shift+tab`, `alt+enter`, `ctrl+shift+left`, …).
- `waitText`, `timeoutMs` — for `wait`. `timeoutMs` on `start` instead sets the session lifetime (default 15 minutes).
- `debounceMs` — output-idle window before an action returns the screen (default 250ms).
- `limit` — for `scrollback`: last N logical lines to return (default 200).
- `at`, `frames`, `render` — for `cast`: `at` reconstructs the screen at that time in seconds; `frames` samples that many frames evenly (the last is the final screen); `render: true` also writes a GIF (needs `agg`).

## Notes

- A driven omp uses the user's real `~/.omp` config, so it registers in the live session registry like any session — and pressing Enter on a typed prompt submits it to the real model. Type prompts to test the editor, but only submit when the test needs a real turn.
- `screen` and `scrollback` work for any command (plain text). `screenshot` and `diff` correlate the spawned child against the omp session registry, so they only work when the driven command is omp.
- The spawn env is scrubbed of terminal-identity variables (`CMUX_*`, `KITTY_*`, `TERM_PROGRAM`, …) and pinned to `TERM=xterm-256color`, so children render for a plain xterm and never inherit a stale cmux surface id. Set `env` explicitly to override.
- Outputs settle by debounce, not by completion: after `input`, an animating TUI (spinners) may keep producing output — use `wait` with `waitText` for a deterministic condition instead of re-polling `screen`.
- `cast` reads the recording back as text without `agg`; only `render: true` shells out to `agg` (asciinema's gif generator), which is optional. Install it to enable GIF output (`brew install agg`, or `cargo install --git https://github.com/asciinema/agg`; see https://docs.asciinema.org/manual/agg/).
