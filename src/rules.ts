/**
 * Idempotent management of the pi-tokensave instruction block inside the
 * AGENTS.md of the session's agent directory (default ~/.pi/agent/AGENTS.md).
 * Content outside the markers is never touched.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveAgentDir } from "./agent-dir.ts";

export const RULES_BLOCK_VERSION = "3";
const START_MARKER = "<!-- pi-tokensave:start -->";
const END_MARKER = "<!-- pi-tokensave:end -->";
const VERSION_MARKER_PREFIX = "<!-- pi-tokensave:version=";

export function agentsMdPath(agentDir: string = resolveAgentDir()): string {
  return join(agentDir, "AGENTS.md");
}

export function buildRulesBlock(version: string = RULES_BLOCK_VERSION): string {
  return `${START_MARKER}
${VERSION_MARKER_PREFIX}${version} -->

## TokenSave Code Intelligence

### Applicability

These rules apply only when the current project contains a \`.tokensave/\`
directory. When it does not, do not call TokenSave tools and use Pi's normal
code exploration tools directly. When a TokenSave tool is unavailable or
blocked in the current turn, also use Pi's normal tools directly.

### Two-Step Rule — mandatory
**Step 1 — Discover:** Use TokenSave tools to locate symbols, understand code
areas, build task context, and analyze dependencies before using grep, find,
or broad speculative reads.

**Step 2 — Verify:** Read the actual source files returned by TokenSave before
writing or modifying code.

TokenSave is a structural code index. It can locate symbols, relationships,
callers, callees, implementations, tests, and likely impact areas. It does not
replace reading the actual implementation or observing runtime behavior.

### Required workflow

For broad tasks or unfamiliar code:

1. Call \`tokensave_context\`.
2. Read the relevant source files returned.
3. Before changing shared logic, call \`tokensave_impact\`.
4. Make the change.
5. Run the relevant tests.

For a named class, function, method, model, interface, type, or constant:

1. Call \`tokensave_find_symbol\`.
2. Do not guess the file path.
3. Read the returned source file before answering implementation questions
   or editing code.

For conceptual code searches:

1. Call \`tokensave_search\`.
2. Use raw grep only when TokenSave returned no useful result or when the task
   explicitly requires complex regex, logs, configuration, generated files,
   literal non-indexed content, or another unsupported format.

Never modify code based only on TokenSave output.

TokenSave tools are orientation and code-intelligence tools. The source code
is the final authority.

${END_MARKER}`;
}

function findBlockRange(content: string): { start: number; end: number } | undefined {
  const start = content.indexOf(START_MARKER);
  if (start === -1) return undefined;
  const end = content.indexOf(END_MARKER, start);
  if (end === -1) return undefined;
  return { start, end: end + END_MARKER.length };
}

export function currentBlockVersion(content: string): string | undefined {
  const range = findBlockRange(content);
  if (!range) return undefined;
  const block = content.slice(range.start, range.end);
  const match = block.match(/<!-- pi-tokensave:version=([^\s]+) -->/);
  return match?.[1];
}

/**
 * Insert or refresh the managed block inside arbitrary file content.
 *
 * Bytes outside the managed block are never touched: no trimming, no
 * whitespace normalization, no blank-line collapsing. When the block is
 * missing, exactly one fixed separator (`\n\n` before, `\n` after) is added
 * on top of whatever bytes were already there — trailing whitespace, missing
 * terminal newlines, CRLF line endings, and existing blank lines are all
 * preserved as-is. When the block already exists, only the substring between
 * the start/end markers is replaced.
 */
export function applyRulesBlock(content: string, version: string = RULES_BLOCK_VERSION): { content: string; changed: boolean } {
  const block = buildRulesBlock(version);
  const range = findBlockRange(content);

  if (!range) {
    const next = content.length === 0 ? `${block}\n` : `${content}\n\n${block}\n`;
    return { content: next, changed: true };
  }

  const existingBlock = content.slice(range.start, range.end);
  if (existingBlock === block) {
    return { content, changed: false };
  }

  const next = content.slice(0, range.start) + block + content.slice(range.end);
  return { content: next, changed: true };
}

/**
 * Removes the managed block and exactly the fixed separator `applyRulesBlock`
 * would have introduced around it (a trailing `\n\n` immediately before the
 * block, a leading `\n` immediately after it), restoring the original
 * surrounding content byte-for-byte for any block that was installed by this
 * module. Everything further away from the block is left untouched.
 */
export function stripRulesBlock(content: string): { content: string; changed: boolean } {
  const range = findBlockRange(content);
  if (!range) return { content, changed: false };

  let before = content.slice(0, range.start);
  let after = content.slice(range.end);

  if (before.endsWith("\n\n")) before = before.slice(0, -2);
  if (after.startsWith("\n")) after = after.slice(1);

  return { content: before + after, changed: true };
}

export function installRulesBlock(path: string = agentsMdPath()): { changed: boolean } {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const { content, changed } = applyRulesBlock(existing);
  if (changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return { changed };
}

export function removeRulesBlock(path: string = agentsMdPath()): { changed: boolean } {
  if (!existsSync(path)) return { changed: false };
  const existing = readFileSync(path, "utf8");
  const { content, changed } = stripRulesBlock(existing);
  if (changed) writeFileSync(path, content, "utf8");
  return { changed };
}
