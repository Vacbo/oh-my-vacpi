Restart the omp process in place and resume this exact session, adopting freshly rebuilt code.

Use this after rebuilding omp (e.g. `bun --cwd=packages/coding-agent run build`) when you need the new build live in YOUR OWN session: upgraded tools, changed runtime behavior, or TUI changes you want to verify from the inside.

## What happens

1. Preflight: the relaunch artifact is boot-probed (`--version`) in a child process. A build that cannot load fails the probe; you get a tool error and the session continues unchanged on the current build.
2. On a passing probe, the current turn ends (in-flight work in this process is aborted), the session is flushed to disk, and the process re-execs in place.
3. The relaunched process resumes this session with full history and auto-submits a confirmation message; you continue from there. Receiving that confirmation IS the proof the restart worked.

## Rules

- Call restart ALONE, never alongside other tool calls: it ends the turn, and siblings in the same batch are aborted.
- Background jobs, child processes, and unfinished work in this process die with it. Finish or persist anything important first.
- For risky or structural changes, validate the build in a disposable child first (`tui_drive` running the rebuilt entry), then restart to adopt it. For small safe changes, restarting directly is fine; the preflight catches builds that cannot boot.
- Residual risk: a build that boots but crashes while resuming this specific session kills the process; the user must fix the build and run `omp --resume`. The conversation is preserved on disk either way.
