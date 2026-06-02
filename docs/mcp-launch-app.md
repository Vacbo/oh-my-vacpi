# `launchApp` — auto-start macOS apps backing stdio MCP servers

Some stdio MCP servers ship as thin CLI proxies into a desktop application.
[RepoPrompt][repoprompt] is the canonical example: its `repoprompt_cli` binary
under `/Applications/Repo Prompt.app/Contents/MacOS/` requires the GUI app to
be running. Launch `omp` while the app is closed and you'll see the CLI spawn,
sit idle waiting for the (absent) app, never respond to `initialize`, and
eventually time out — burning every prompt's context budget on a tool list the
agent can never call.

`launchApp` fixes this by making `omp` ensure the macOS app is running before
spawning the proxy command. macOS-only.

## Config

In `~/.omp/agent/mcp.json` (or any project-level `.mcp.json`):

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "RepoPrompt": {
      "type": "stdio",
      "command": "/Users/me/RepoPrompt/repoprompt_cli",
      "launchApp": "Repo Prompt",
      "timeout": 14400000,
      "connectTimeoutMs": 10000
    }
  }
}
```

### Shape

- **String shorthand** (`"Repo Prompt"`): launches in the background with
  `open -gja "<value>"` — no focus steal. Accepts any value `open -a`
  understands: app name, full bundle path (`/Applications/Repo Prompt.app`),
  or bundle id.
- **Object** (`{ path, foreground? }`): explicit. `foreground` defaults to
  `false`. Set `true` to activate the app on launch (`open -a "<path>"`)
  instead of the silent background launch.

`launchApp` is **only valid for stdio transport** — the validator rejects it on
`http`/`sse` server configs.

## How it interacts with `connectTimeoutMs`

`launchApp` and `connectTimeoutMs` are independent fixes for the same family
of bugs:

- `launchApp` removes one source of "subprocess alive but unresponsive" by
  guaranteeing the backing app is up.
- `connectTimeoutMs` (default 30s) bounds the handshake regardless of what's
  going on inside the subprocess, so an unknown stall still fails fast.

If `launchApp` itself fails (`open` non-zero exit, non-darwin platform), the
error is classified as `unreachable` and surfaced via `MCPManager.getLastConnectError`
— visible in `/mcp` and `/info` next to the server name.

## What you'll see in `/mcp`

With the app **closed** and `launchApp` **unset**:

```
RepoPrompt  ○ not connected  [stdio]
  ↳ RepoPrompt: subprocess exited before responding to initialize
```

With `launchApp: "Repo Prompt"` set, app closed at session start: the app
launches in the background and the entry transitions to `● connected` within
~1s.

## Why not just lower `timeout`?

`timeout` bounds *every* MCP request, including `tools/call`. Servers like
`@oh-my-pi/oracle` and `agent_run`-style proxies legitimately take many
minutes to return. Reusing the same setting for connect-handshake and per-call
duration forced a bad tradeoff. `connectTimeoutMs` separates them.

[repoprompt]: https://repoprompt.com
