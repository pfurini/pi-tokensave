# pi-tokensave

Native [Pi](https://pi.dev) extension that makes the agent use [TokenSave](https://github.com/dan-developer/pi-tokensave) code
intelligence *before* falling back to `grep`, `find`, or speculative file reads.

**This plugin does not use MCP.** It calls the local `tokensave` CLI directly via
`tokensave tool <name> --project <root> --args <json> --json`. It never runs `tokensave serve`,
never touches `.tokensave/tokensave.db` directly, and never writes `mcp.json`.

## Requirements

- Pi (`@earendil-works/pi-coding-agent`), current version.
- The `tokensave` binary on `PATH` (or `TOKENSAVE_BIN` pointing to it).

## Install TokenSave

```bash
# see https://tokensave.dev for the current install method
tokensave --version
```

Initialize the project you want indexed:

```bash
tokensave init .
```

TokenSave keeps its index in `.tokensave/`. The plugin never initializes a project
automatically — it always asks first (`/tokensave-init`).

## Install the plugin

```bash
pi install git:github.com/dan-developer/pi-tokensave
```

Or for local development:

```bash
pi -e /path/to/pi-tokensave
```

## Tools exposed to the model

All six tools are read-only. They never expose TokenSave's write/mutation tools
(`str_replace`, `replace_symbol`, `ast_grep_rewrite`, etc.) — code changes still
go through Pi's normal `edit`/`write` tools.

| Tool | Purpose |
|---|---|
| `tokensave_status` | Binary/init/graph health check |
| `tokensave_context` | Build task context: entry points, related symbols, snippets |
| `tokensave_find_symbol` | Locate a named class/function/method/... prioritizing exact matches |
| `tokensave_search` | Conceptual/keyword/literal search when no exact name is known |
| `tokensave_symbol` | Compact view of a symbol: signature, body, callers, callees, implementations |
| `tokensave_impact` | Blast-radius analysis before changing shared code |

TokenSave output is always a starting point. Reading the actual source file before
making implementation claims or edits remains part of the required workflow — this
is stated in every tool's guidelines and in the injected instructions.

## Commands

```
/tokensave-status          Show binary/init/graph status
/tokensave-init            Initialize TokenSave for this project (asks to confirm)
/tokensave-sync            Incremental sync
/tokensave-mode            Show current mode
/tokensave-mode prefer     Switch to prefer mode
/tokensave-mode enforce    Switch to enforce mode (default)
/tokensave-rules-install   Install/update the AGENTS.md instructions block
/tokensave-rules-remove    Remove only the pi-tokensave block from AGENTS.md
/tokensave-doctor          Diagnose binary, init, rules block, mode, and any leftover MCP integration
```

Mode is persisted to `~/.pi/agent/pi-tokensave.json` (never inside the project).

## Modes

- **`enforce`** (default) — blocks a narrow set of manual searches that look like
  named-symbol discovery (e.g. `rg "WellModel" .`, `grep -R "class WellModel" .`,
  `find . -iname "*wellmodel*"`) when TokenSave is installed, the project is
  initialized, and TokenSave has not already been consulted for that symbol in
  the current session. Everything else — complex regex, pipelines, `git grep`,
  logs, config files, migrations, generated code, markdown, JSON/YAML/TOML — is
  allowed through unmodified. After TokenSave returns no result or errors, the
  fallback to manual search is allowed for that investigation.
- **`prefer`** — never blocks. Shows the tools, injects the instructions, and may
  emit a single short notice per session when it sees manual exploration that
  TokenSave could have served instead.

## Instructions block

The plugin manages an idempotent block in `~/.pi/agent/AGENTS.md` between
`<!-- pi-tokensave:start -->` / `<!-- pi-tokensave:end -->` markers. Everything
else in that file is left untouched. It is installed on first load and refreshed
on every `session_start` (no-op when already up to date). The same instructions
are also injected into the current session's system prompt via `before_agent_start`,
so a fresh install applies immediately without requiring `/reload`.

## Uninstall

```bash
pi remove git:github.com/dan-developer/pi-tokensave
```

Remove the instructions block separately if desired:

```
/tokensave-rules-remove
```

## Troubleshooting

- **"TokenSave binary not found"** — install `tokensave` and ensure it is on
  `PATH`, or set `TOKENSAVE_BIN` to its absolute path.
- **"TokenSave is not initialized for this project"** — run `/tokensave-init`.
- **Guard blocks a search you believe is legitimate** — switch to `prefer` mode
  (`/tokensave-mode prefer`), or run the underlying TokenSave query first
  (`tokensave_find_symbol`) so the fallback becomes allowed automatically.
- **`tokensave doctor` shows a Pi MCP integration** — `/tokensave-doctor` reads
  Pi's own `mcp.json` (`$PI_CODING_AGENT_DIR/mcp.json`, else `~/.pi/agent/mcp.json`)
  and reports whether a TokenSave MCP server is registered, i.e. whether
  `mcpServers.tokensave` is present:

  ```json
  {
    "mcpServers": {
      "tokensave": {}
    }
  }
  ```

  It parses `mcp.json` directly instead of scraping human-readable
  `tokensave doctor` output, and it **never modifies the file automatically**.
  It does not affect pi-tokensave, which never uses MCP. To remove only the Pi
  integration, run `tokensave uninstall --agent pi`. **Never run bare
  `tokensave uninstall`** — without `--agent` it removes every agent's TokenSave
  integration, not just Pi's.
