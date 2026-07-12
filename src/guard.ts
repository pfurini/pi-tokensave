/**
 * Enforce-mode guard: intercepts built-in `grep`/`find` tool calls and plain
 * `bash` invocations of rg/grep/ag/ack/find, and blocks them when they look
 * like named-symbol discovery that should go through TokenSave first.
 *
 * Deliberately conservative: only blocks a narrow, high-confidence pattern.
 * Everything else (complex regex, pipelines, git grep, logs, config files,
 * generated code, migrations, markdown, JSON/YAML/TOML) is allowed through.
 */

import type { TokensaveMode } from "./state.ts";

export const BLOCKED_SEARCH_MESSAGE = [
  "Blocked by pi-tokensave.",
  "",
  "This looks like named-symbol or code-location discovery.",
  "Call `tokensave_find_symbol` first.",
  "",
  "Raw search is allowed after TokenSave returns no useful result or when",
  "the search explicitly requires regex, logs, configuration, generated",
  "files, or non-indexed content.",
].join("\n");

const SEARCH_BINARIES = new Set(["rg", "grep", "ag", "ack", "find"]);

const EXCLUDED_TARGET_PATTERN =
  /(\.md$|\.markdown$|\.json$|\.ya?ml$|\.toml$|\.lock$|\.log$|\/?migrations?\/|\/generated\/|\/dist\/|\/build\/|\/vendor\/|\/node_modules\/|\.env)/i;

const DECLARATION_KEYWORD_PATTERN =
  /^(class|interface|struct|enum|trait|impl|type|def|function|func|module)\s+([A-Za-z_][A-Za-z0-9_]*)/;

const BARE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Returns the bare identifier being searched for if `raw` looks like a
 * named-symbol search (e.g. "WellModel", "class WellModel", "*wellmodel*"),
 * or undefined if it does not.
 */
export function extractSymbolCandidate(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;

  const declMatch = text.match(DECLARATION_KEYWORD_PATTERN);
  if (declMatch) return declMatch[2];

  const stripped = text.replace(/^\*+|\*+$/g, "").replace(/^\?+|\?+$/g, "");
  if (BARE_IDENTIFIER_PATTERN.test(stripped) && stripped.length >= 3) {
    return stripped;
  }

  return undefined;
}

export function isExcludedTarget(...texts: Array<string | undefined>): boolean {
  return texts.some((text) => text !== undefined && EXCLUDED_TARGET_PATTERN.test(text));
}

interface GrepLikeInput {
  pattern?: string;
  path?: string;
  glob?: string;
  literal?: boolean;
}

export function evaluateGrepOrFind(input: GrepLikeInput): string | undefined {
  if (!input.pattern) return undefined;
  if (isExcludedTarget(input.path, input.glob, input.pattern)) return undefined;
  return extractSymbolCandidate(input.pattern);
}

/** Very small whitespace/quote-aware tokenizer, heuristic-only (not exec). */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

const COMPLEX_SHELL_PATTERN = /[|;>]|&&/;

export function extractBashSearchCandidate(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed || COMPLEX_SHELL_PATTERN.test(trimmed)) return undefined;

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return undefined;

  const [binary, ...rest] = tokens;
  if (binary === "git") return undefined; // `git grep` explicitly allowed
  if (!SEARCH_BINARIES.has(binary)) return undefined;

  const targets = rest.filter((tok) => !tok.startsWith("-"));
  if (targets.length === 0) return undefined;

  if (isExcludedTarget(...targets)) return undefined;

  for (const target of targets) {
    const candidate = extractSymbolCandidate(target);
    if (candidate) return candidate;
  }
  return undefined;
}

export type GuardableToolName = "bash" | "grep" | "find";

/**
 * Extracts a symbol-search candidate from a `bash`/`grep`/`find` tool_call
 * input, independent of mode or TokenSave availability. Returns undefined
 * when the call does not look like named-symbol discovery.
 */
export function detectSearchCandidate(toolName: GuardableToolName, input: unknown): string | undefined {
  if (toolName === "bash") {
    const command = (input as { command?: string })?.command;
    return typeof command === "string" ? extractBashSearchCandidate(command) : undefined;
  }
  return evaluateGrepOrFind((input as GrepLikeInput) ?? {});
}

export interface GuardCheckParams {
  toolName: GuardableToolName;
  input: unknown;
  mode: TokensaveMode;
  tokensaveAvailable: boolean;
  projectInitialized: boolean;
  wasConsulted: (candidate: string) => boolean;
}

export interface GuardDecision {
  block: boolean;
  candidate?: string;
  reason?: string;
}

export function evaluateGuard(params: GuardCheckParams): GuardDecision {
  if (params.mode !== "enforce") return { block: false };
  if (!params.tokensaveAvailable || !params.projectInitialized) return { block: false };

  const candidate = detectSearchCandidate(params.toolName, params.input);
  if (!candidate) return { block: false };
  if (params.wasConsulted(candidate)) return { block: false };

  return { block: true, candidate, reason: BLOCKED_SEARCH_MESSAGE };
}
