/**
 * Resolves the Pi agent configuration directory that backs the current session.
 *
 * Hosts that expose `agentDir` on the extension API and context report the
 * directory of the session loading the extension. That directory differs from
 * the global one for sessions created with an explicit `agentDir`. Hosts without
 * the field fall back to the resolution of Pi's own `getAgentDir()`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/**
 * `source` is the extension API (at load time) or an event context. Reading
 * `agentDir` structurally keeps the extension working on hosts without it.
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
