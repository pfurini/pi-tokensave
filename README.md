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

Settings are persisted to `pi-tokensave.json` in Pi's agent directory, never inside
the project. The agent directory is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` or an
SDK session created with its own `agentDir` points elsewhere:

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

Both modes inspect the `bash`, `grep`, and `find` tools, plus the `anchor_grep` tool
from [pi-hashline-edit-pro](https://www.npmjs.com/package/pi-hashline-edit-pro),
which replaces `grep` in sessions that load it.

Both modes stand down in a session where `tokensave_find_symbol` is not an active
tool, because the block message and the notice point at it. The rules block is
likewise injected only when at least one `tokensave_*` tool is active. This covers
[pi-subagents](https://github.com/tintinweb/pi-subagents) agents whose `tools:` list
or `ext:` selectors leave pi-tokensave's tools out. A skill's `disallowed-tools` is
not visible to extensions: while such a skill runs, switch to `prefer` mode if it
disallows the TokenSave tools.

## Pi-managed branch indexes

When `autoManageBranches` is `true`, the extension keeps TokenSave indexes aligned
with local Git state. It reconciles whenever a local branch is created, checked out,
renamed, deleted, or moved to a new commit:

- `tokensave branch add` tracks the checked-out branch.
- `tokensave sync` refreshes the checked-out branch index.
- `tokensave branch gc` removes indexes of deleted local branches.

The sync step does the work of TokenSave's `post-commit` git hook. That hook never
runs in a repository that sets its own `core.hooksPath` (husky, for example), so
without this step the index stays at the last manual sync.

Reconciliation starts at session start without delaying it. A TokenSave tool call
waits for a reconciliation in progress, and starts one when the branch names or
tips changed since the last run. Unchanged refs cost one `git branch` call and no
TokenSave process. When another process already holds TokenSave's sync lock, the
extension skips the step silently and retries at the next TokenSave tool call.

Every session in one Pi process shares the reconciliation state, keyed by project
root. A pi-subagents child therefore finds the work its parent already did, or waits
for the parent's run in progress, instead of repeating `branch add`, `sync`, and
`branch gc`. A child that runs in its own git worktree has a different root, so it
reconciles that worktree.

This automation runs only while Pi is active. Git changes made elsewhere are
reconciled when the next Pi session starts or TokenSave tool runs. Uncommitted edits
are not synced; run `/tokensave-sync` for those.

## Instructions block

The plugin manages an idempotent block in the agent directory's `AGENTS.md`
(`~/.pi/agent/AGENTS.md` by default) between
`<!-- pi-tokensave:start -->` / `<!-- pi-tokensave:end -->` markers. Everything
else in that file is left untouched. It is installed on first load and refreshed
on every `session_start` (no-op when already up to date). The block explicitly
applies only to projects containing `.tokensave/`.

When the system prompt of a run does not already contain the block, the extension
adds it through `before_agent_start` as a `<tokensave>` prompt section. That covers
the first session after installation (Pi read `AGENTS.md` before the block existed)
and subagent sessions, which load no `AGENTS.md`. A section leaves the rest of the
prompt intact. On hosts without prompt sections, or when an earlier extension already
replaced the whole prompt, the block is appended to the prompt text instead.
Injection happens only when `.tokensave/` exists, so uninitialized projects neither
probe the TokenSave binary nor change the normal exploration workflow.

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
