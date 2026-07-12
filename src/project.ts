/**
 * Project root resolution and TokenSave installation/init detection.
 * No direct access to the .tokensave/tokensave.db file — only existence
 * checks on the directory. Actual data always comes through the CLI.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const TOKENSAVE_DIR_NAME = ".tokensave";

const MAX_ANCESTOR_HOPS = 50;

/**
 * Walks from `cwd` upward looking for a `.tokensave` directory, stopping at
 * the nearest Git repository boundary (a directory containing `.git`) or the
 * filesystem root, whichever comes first. This lets Pi be started from a
 * subdirectory of an initialized project (e.g. `/project/backend/api` when
 * `.tokensave` lives at `/project`).
 *
 * If no `.tokensave` is found before (and including) the Git boundary, the
 * original `cwd` is returned unchanged so downstream "not initialized"
 * messaging stays accurate for the directory the user is actually in.
 */
export function resolveProjectRoot(cwd: string): string {
  let dir = cwd;
  for (let hop = 0; hop <= MAX_ANCESTOR_HOPS; hop++) {
    if (existsSync(join(dir, TOKENSAVE_DIR_NAME))) return dir;
    if (existsSync(join(dir, ".git"))) return dir;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

export function isProjectInitialized(projectRoot: string): boolean {
  return existsSync(join(projectRoot, TOKENSAVE_DIR_NAME));
}

export function resolveTokensaveBinary(): string {
  return process.env.TOKENSAVE_BIN?.trim() || "tokensave";
}
