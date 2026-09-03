/**
 * Session-scoped guard state and persisted user preference (mode).
 *
 * Persisted mode lives under ~/.pi/agent/ (never inside the project) per a
 * simple JSON file. Session state is in-memory only and is intentionally
 * small: it exists to unblock the guard after TokenSave has been consulted,
 * or after it failed/returned nothing useful.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type TokensaveMode = "prefer" | "enforce";

export interface TokensaveConfig {
  mode: TokensaveMode;
  autoManageBranches: boolean;
}

export const DEFAULT_MODE: TokensaveMode = "enforce";
export const DEFAULT_AUTO_MANAGE_BRANCHES = false;

export function modeConfigPath(): string {
  return join(homedir(), ".pi", "agent", "pi-tokensave.json");
}

function readPersistedConfig(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function loadPersistedConfig(path: string = modeConfigPath()): TokensaveConfig {
  const parsed = readPersistedConfig(path);
  return {
    mode: parsed.mode === "prefer" ? "prefer" : DEFAULT_MODE,
    autoManageBranches: parsed.autoManageBranches === true,
  };
}

export function loadPersistedMode(path: string = modeConfigPath()): TokensaveMode {
  return loadPersistedConfig(path).mode;
}

export function savePersistedMode(mode: TokensaveMode, path: string = modeConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const config = { ...readPersistedConfig(path), mode };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export interface TokensaveSessionState {
  mode: TokensaveMode;
  /** undefined = not checked yet this session */
  binaryAvailable: boolean | undefined;
  /** Normalized query fragments TokenSave has already been asked about. */
  consultedQueries: string[];
  /** Set when the most recent TokenSave call failed or returned nothing useful. */
  lastCallFailedOrEmpty: boolean;
  lastFailureMessage?: string;
  warnedManualExplorationOnce: boolean;
}

export function createSessionState(mode: TokensaveMode): TokensaveSessionState {
  return {
    mode,
    binaryAvailable: undefined,
    consultedQueries: [],
    lastCallFailedOrEmpty: false,
    warnedManualExplorationOnce: false,
  };
}

const MAX_CONSULTED_QUERIES = 50;

export function normalizeQueryFragment(text: string): string {
  return text.trim().toLowerCase();
}

export function recordConsultation(state: TokensaveSessionState, query: string, succeededWithResults: boolean): void {
  const normalized = normalizeQueryFragment(query);
  if (normalized.length >= 2) {
    state.consultedQueries.push(normalized);
    if (state.consultedQueries.length > MAX_CONSULTED_QUERIES) {
      state.consultedQueries.shift();
    }
  }
  state.lastCallFailedOrEmpty = !succeededWithResults;
}

export function recordFailure(state: TokensaveSessionState, message: string): void {
  state.lastCallFailedOrEmpty = true;
  state.lastFailureMessage = message;
}

/**
 * Conservative match: a candidate search term is considered "already
 * consulted" if it shares a case-insensitive substring relationship with
 * any previously consulted query fragment.
 */
export function wasCandidateConsulted(state: TokensaveSessionState, candidate: string): boolean {
  const normalized = normalizeQueryFragment(candidate);
  if (!normalized) return false;
  return state.consultedQueries.some(
    (query) => query.includes(normalized) || normalized.includes(query),
  );
}
