/**
 * Central executor for TokenSave CLI tool calls.
 *
 * Always shells out to `tokensave tool <name> --project <root> --args <json> --json`
 * using execFile (array args, no shell). Never touches the .tokensave database
 * directly and never starts `tokensave serve`.
 */

import { execFile } from "node:child_process";
import { resolveTokensaveBinary } from "./project.ts";

export interface TokensaveRunOptions {
  projectRoot: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export type TokensaveErrorKind =
  | "binary_not_found"
  | "project_not_initialized"
  | "malformed_json"
  | "empty_result"
  | "command_failed"
  | "timeout"
  | "cancelled";

export interface TokensaveRunOk {
  ok: true;
  toolName: string;
  /** Parsed JSON payload, or a wrapper object when the payload could not be
   * fully represented within maxOutputChars. */
  data: unknown;
  /** True when the tool returned human-readable markdown instead of JSON
   * (e.g. `context` in some modes). */
  isMarkdown: boolean;
  truncated: boolean;
  truncationNote?: string;
}

export interface TokensaveRunError {
  ok: false;
  toolName: string;
  kind: TokensaveErrorKind;
  message: string;
}

export type TokensaveRunResult = TokensaveRunOk | TokensaveRunError;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const DEFAULT_COMMAND_OUTPUT_MAX_CHARS = 8_000;

interface SpawnedChildLike {
  stdin?: { end: () => void } | null;
}

interface ExecFileLike {
  (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number; signal?: AbortSignal; cwd?: string },
    callback: (error: (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null, stdout: string, stderr: string) => void,
  ): SpawnedChildLike;
}

/** Immediately closes stdin so a spawned tokensave process never blocks
 * waiting on an interactive prompt (e.g. the gitignore prompt from `init`). */
function closeStdin(child: SpawnedChildLike): void {
  child.stdin?.end();
}

let execFileImpl: ExecFileLike = execFile as unknown as ExecFileLike;

/** Test-only seam. Never used in production code paths. */
export function setExecFileImplForTest(fn: ExecFileLike | undefined): void {
  execFileImpl = (fn ?? (execFile as unknown as ExecFileLike));
}

export async function runTokensaveTool(
  toolName: string,
  args: Record<string, unknown>,
  options: TokensaveRunOptions,
): Promise<TokensaveRunResult> {
  const binary = resolveTokensaveBinary();
  const cliArgs = ["tool", toolName, "--project", options.projectRoot, "--args", JSON.stringify(args), "--json"];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const { stdout, stderr, error } = await new Promise<{
    stdout: string;
    stderr: string;
    error: (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
  }>((resolve) => {
    closeStdin(execFileImpl(
      binary,
      cliArgs,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, signal: options.signal },
      (err, out, errOut) => resolve({ stdout: out ?? "", stderr: errOut ?? "", error: err }),
    ));
  });

  if (error) {
    return classifyExecError(toolName, error, stdout, stderr, timeoutMs, options.signal);
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    return { ok: false, toolName, kind: "empty_result", message: `TokenSave tool '${toolName}' returned no output.` };
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(trimmed);
  } catch {
    return { ok: false, toolName, kind: "malformed_json", message: `TokenSave tool '${toolName}' returned malformed JSON output: ${trimmed.slice(0, 200)}` };
  }

  const text = extractContentText(envelope);
  if (text === undefined) {
    return { ok: false, toolName, kind: "malformed_json", message: `TokenSave tool '${toolName}' returned an unexpected response shape.` };
  }

  const maxChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  return buildOkResult(toolName, text, maxChars);
}

function classifyExecError(
  toolName: string,
  error: NodeJS.ErrnoException & { killed?: boolean; signal?: string },
  stdout: string,
  stderr: string,
  timeoutMs: number,
  signal?: AbortSignal,
): TokensaveRunError {
  if (error.code === "ENOENT") {
    return {
      ok: false,
      toolName,
      kind: "binary_not_found",
      message: "TokenSave binary not found on PATH. Install TokenSave or set TOKENSAVE_BIN, then retry.",
    };
  }

  if (signal?.aborted || error.name === "AbortError") {
    return { ok: false, toolName, kind: "cancelled", message: "TokenSave call was cancelled." };
  }

  if (error.killed && error.signal) {
    return {
      ok: false,
      toolName,
      kind: "timeout",
      message: `TokenSave tool '${toolName}' timed out after ${timeoutMs}ms.`,
    };
  }

  const combined = (stderr || stdout || error.message || "").trim();
  if (/no tokensave index found/i.test(combined) || /run `?tokensave init`?/i.test(combined)) {
    return {
      ok: false,
      toolName,
      kind: "project_not_initialized",
      message: combined || "Project is not initialized. Run 'tokensave init' first.",
    };
  }

  return {
    ok: false,
    toolName,
    kind: "command_failed",
    message: combined || `TokenSave tool '${toolName}' failed.`,
  };
}

function extractContentText(envelope: unknown): string | undefined {
  if (
    envelope &&
    typeof envelope === "object" &&
    Array.isArray((envelope as { content?: unknown }).content)
  ) {
    const content = (envelope as { content: unknown[] }).content;
    const first = content[0] as { type?: string; text?: unknown } | undefined;
    if (first && typeof first.text === "string") return first.text;
  }
  return undefined;
}

function buildOkResult(toolName: string, text: string, maxChars: number): TokensaveRunOk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const truncated = text.length > maxChars;
    return {
      ok: true,
      toolName,
      data: truncated ? `${text.slice(0, maxChars).trimEnd()}\n…` : text,
      isMarkdown: true,
      truncated,
      truncationNote: truncated
        ? `TokenSave output was truncated to ${maxChars} characters (original length ${text.length}).`
        : undefined,
    };
  }

  const serialized = JSON.stringify(parsed);
  if (serialized.length <= maxChars) {
    return { ok: true, toolName, data: parsed, isMarkdown: false, truncated: false };
  }

  if (Array.isArray(parsed)) {
    const kept = truncateArrayToBudget(parsed, maxChars);
    return {
      ok: true,
      toolName,
      data: kept,
      isMarkdown: false,
      truncated: true,
      truncationNote: `Returned ${kept.length} of ${parsed.length} items. Output was too large; refine the query or limit.`,
    };
  }

  return {
    ok: true,
    toolName,
    data: `${serialized.slice(0, maxChars).trimEnd()}\n…`,
    isMarkdown: true,
    truncated: true,
    truncationNote: `TokenSave JSON output was too large (${serialized.length} chars) and could not be shown in full. Refine the query or use a more specific tool call.`,
  };
}

export interface TokensaveRawCommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorKind?: "binary_not_found" | "timeout" | "command_failed";
}

/**
 * Bounds a command output string to `maxChars`, appending an explicit
 * truncation notice rather than silently cutting text off.
 */
function boundOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n…\n[output truncated to ${maxChars} characters; original length ${text.length}]`;
}

/**
 * Runs a plain `tokensave <subcommand> [args...]` invocation (init/sync/
 * doctor) rather than the `tool` subcommand. No --json is used because
 * these subcommands do not support it; output is ANSI-stripped for display.
 */
export async function runTokensaveCommand(
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
  maxOutputChars = DEFAULT_COMMAND_OUTPUT_MAX_CHARS,
): Promise<TokensaveRawCommandResult> {
  const binary = resolveTokensaveBinary();
  const { stdout, stderr, error } = await new Promise<{
    stdout: string;
    stderr: string;
    error: (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
  }>((resolve) => {
    closeStdin(execFileImpl(binary, args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, cwd }, (err, out, errOut) =>
      resolve({ stdout: out ?? "", stderr: errOut ?? "", error: err }),
    ));
  });

  const clean = (text: string) => boundOutput(stripAnsi(text).trim(), maxOutputChars);

  if (error) {
    if (error.code === "ENOENT") {
      return { ok: false, exitCode: null, stdout: "", stderr: "", errorKind: "binary_not_found" };
    }
    if (error.killed && error.signal) {
      return { ok: false, exitCode: null, stdout: clean(stdout), stderr: clean(stderr), errorKind: "timeout" };
    }
    return {
      ok: false,
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: clean(stdout),
      stderr: clean(stderr),
      errorKind: "command_failed",
    };
  }

  return { ok: true, exitCode: 0, stdout: clean(stdout), stderr: clean(stderr) };
}

function stripAnsi(text: string): string {
  // biome-ignore lint: intentional control-character strip for terminal escape sequences
  return text.replace(/[\u001B\u009B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

export type TokensaveAvailabilityReason = "not_found" | "timeout" | "permission_denied" | "failed";

export interface TokensaveAvailability {
  available: boolean;
  reason?: TokensaveAvailabilityReason;
}

/**
 * Determines whether `tokensave --version` actually completes successfully.
 * Any error (missing binary, timeout, permission failure, crash, non-zero
 * exit) is treated as unavailable — enforcement must never assume TokenSave
 * is usable just because the exec call didn't hit ENOENT.
 */
export async function checkTokensaveAvailability(timeoutMs = 4000): Promise<TokensaveAvailability> {
  const binary = resolveTokensaveBinary();
  return new Promise((resolve) => {
    closeStdin(execFileImpl(binary, ["--version"], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error) => {
      if (!error) {
        resolve({ available: true });
        return;
      }
      if (error.code === "ENOENT") {
        resolve({ available: false, reason: "not_found" });
        return;
      }
      if (error.killed && error.signal) {
        resolve({ available: false, reason: "timeout" });
        return;
      }
      if (error.code === "EACCES") {
        resolve({ available: false, reason: "permission_denied" });
        return;
      }
      resolve({ available: false, reason: "failed" });
    }));
  });
}

/** Convenience boolean wrapper over {@link checkTokensaveAvailability}. */
export async function checkTokensaveAvailable(timeoutMs = 4000): Promise<boolean> {
  const { available } = await checkTokensaveAvailability(timeoutMs);
  return available;
}

function truncateArrayToBudget(items: unknown[], maxChars: number): unknown[] {
  const kept: unknown[] = [];
  let size = 2;
  for (const item of items) {
    const itemSize = JSON.stringify(item).length + 1;
    if (size + itemSize > maxChars && kept.length > 0) break;
    kept.push(item);
    size += itemSize;
  }
  return kept.length > 0 ? kept : items.slice(0, 1);
}
