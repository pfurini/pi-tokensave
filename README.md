# pi-tokensave

Native [Pi](https://pi.dev) extension that makes the agent use [TokenSave](https://github.com/dan-developer/pi-tokensave) code
intelligence *before* falling back to `grep`, `find`, or speculative file reads.

pi-tokensave registers native Pi tools and invokes the local TokenSave CLI directly.

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
/tokensave-doctor          Diagnose binary, init, rules block, and mode
```

Settings are persisted to `~/.pi/agent/pi-tokensave.json` (never inside the project):

```json
{
  "mode": "enforce",
  "autoManageBranches": true
}
```

`autoManageBranches` is opt-in and defaults to `false`.

## Modes

- **`enforce`** (default) — blocks a narrow set of manual searches that look like
  named-symbol discovery (e.g. `rg "WellModel" .`, `grep -R "class WellModel" .`,
  `find . -iname "*wellmodel*"`) when TokenSave is installed, the project is
  initialized, and TokenSave has not already been consulted for that symbol in
  the current session. Everything else — complex regex, pipelines, `git grep`,
  logs, config files, migrations, generated code, markdown, JSON/YAML/TOML — is
  allowed through unmodified. After TokenSave returns no result or errors, the
  fallback to manual search is allowed for that investigation.
- **`prefer`** — never blocks. Shows the tools, injects the instructions in
  initialized projects, and may emit a single short notice per session when it
  sees manual exploration that TokenSave could have served instead.

## Pi-managed branch indexes

When `autoManageBranches` is `true`, the extension reconciles TokenSave indexes at
session start and before a TokenSave tool call whenever the local branch set or
current branch changed. It runs `tokensave branch add` for the checked-out branch
and `tokensave branch gc` to remove indexes for deleted local branches.

The extension fingerprints local branch refs, so unchanged tool calls do not spawn
additional TokenSave commands. This automation runs only while Pi is active; branch
changes made elsewhere are reconciled when the next Pi session starts or TokenSave
tool runs.

## Instructions block

The plugin manages an idempotent block in `~/.pi/agent/AGENTS.md` between
`<!-- pi-tokensave:start -->` / `<!-- pi-tokensave:end -->` markers. Everything
else in that file is left untouched. It is installed on first load and refreshed
on every `session_start` (no-op when already up to date). The block explicitly
applies only to projects containing `.tokensave/`. The same instructions are
injected into the current session's system prompt via `before_agent_start` only
when that directory exists, so uninitialized projects neither probe the TokenSave
binary nor change the normal exploration workflow.

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
