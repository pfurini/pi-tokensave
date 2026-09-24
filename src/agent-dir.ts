/**
 * Resolves the Pi agent configuration directory that backs the current session.
 *
 * The Pi fork (github.com/pfurini/pi) exposes `agentDir` on the extension API and
 * context: the directory of the session loading the extension. That directory
 * differs from the global one for sessions created with an explicit `agentDir`.
 * Upstream Pi 0.87 has no such field; there the extension falls back to the
 * resolution of Pi's own `getAgentDir()`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/**
 * `source` is the extension API (at load time) or an event context. Reading
 * `agentDir` structurally keeps the extension working on upstream Pi.
 */
export function resolveAgentDir(source?: object): string {
  const reported = (source as { agentDir?: unknown } | undefined)?.agentDir;
  if (typeof reported === "string" && reported.length > 0) return reported;

  const fromEnv = process.env[AGENT_DIR_ENV]?.trim();
  if (fromEnv) return expandHome(fromEnv);

  return join(homedir(), ".pi", "agent");
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
