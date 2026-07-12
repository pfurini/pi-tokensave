/**
 * Slash commands: status, init, sync, mode switch, rules install/remove, doctor.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isProjectInitialized, resolveProjectRoot, resolveTokensaveBinary } from "./project.ts";
import { checkTokensaveAvailable, runTokensaveCommand } from "./runner.ts";
import { agentsMdPath, installRulesBlock, removeRulesBlock } from "./rules.ts";
import { modeConfigPath, savePersistedMode, type TokensaveMode } from "./state.ts";

type GetState = () => { mode: TokensaveMode };
type SetMode = (mode: TokensaveMode) => void;

async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
  const root = resolveProjectRoot(ctx.cwd);
  const available = await checkTokensaveAvailable();
  if (!available) {
    ctx.ui.notify("TokenSave binary not found on PATH.", "error");
    return;
  }
  if (!isProjectInitialized(root)) {
    ctx.ui.notify("TokenSave is not initialized for this project. Run /tokensave-init.", "warning");
    return;
  }
  const result = await runTokensaveCommand(["status", root], root);
  ctx.ui.notify(result.stdout || result.stderr || "No output.", result.ok ? "info" : "error");
}

async function handleInit(ctx: ExtensionCommandContext): Promise<void> {
  const root = resolveProjectRoot(ctx.cwd);
  if (isProjectInitialized(root)) {
    ctx.ui.notify("TokenSave is already initialized for this project.", "info");
    return;
  }
  const confirmed = await ctx.ui.confirm("Initialize TokenSave", `Run 'tokensave init' in ${root}?`);
  if (!confirmed) {
    ctx.ui.notify("Cancelled.", "info");
    return;
  }
  const result = await runTokensaveCommand(["init", root], root);
  ctx.ui.notify(result.stdout || result.stderr || "No output.", result.ok ? "info" : "error");
}

async function handleSync(ctx: ExtensionCommandContext): Promise<void> {
  const root = resolveProjectRoot(ctx.cwd);
  if (!isProjectInitialized(root)) {
    ctx.ui.notify("TokenSave is not initialized. Run /tokensave-init first.", "warning");
    return;
  }
  const result = await runTokensaveCommand(["sync", root, "--doctor"], root);
  ctx.ui.notify(result.stdout || result.stderr || "No output.", result.ok ? "info" : "error");
}

/**
 * Resolves Pi's own MCP config file path: `$PI_CODING_AGENT_DIR/mcp.json`
 * when that environment variable is set, otherwise `~/.pi/agent/mcp.json`.
 */
export function piMcpConfigPath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR?.trim();
  return dir ? join(dir, "mcp.json") : join(homedir(), ".pi", "agent", "mcp.json");
}

/**
 * Detects an actual TokenSave MCP server registration by reading Pi's own
 * mcp.json directly, rather than pattern-matching `tokensave doctor`'s
 * human-readable output (which places "Pi integration" and "MCP server
 * registered" on different lines, so a same-line regex over that text
 * false-negatives). The file is only ever read here, never modified.
 */
function hasTokensaveMcpIntegration(path: string = piMcpConfigPath()): boolean {
  if (!existsSync(path)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const mcpServers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (typeof mcpServers !== "object" || mcpServers === null) return false;
  const tokensaveEntry = (mcpServers as Record<string, unknown>).tokensave;
  return typeof tokensaveEntry === "object" && tokensaveEntry !== null;
}

async function handleDoctor(
  ctx: ExtensionCommandContext,
  getState: GetState,
  agentsPathOverride?: string,
  mcpPathOverride?: string,
): Promise<void> {
  const root = resolveProjectRoot(ctx.cwd);
  const lines: string[] = [];

  const binaryPath = resolveTokensaveBinary();
  const available = await checkTokensaveAvailable();
  lines.push(available ? `✔ Binary found: ${binaryPath}` : `✘ Binary not found: ${binaryPath}`);

  const initialized = isProjectInitialized(root);
  lines.push(initialized ? `✔ Project initialized (${join(root, ".tokensave")})` : "✘ Project not initialized. Run /tokensave-init.");

  const agentsPath = agentsPathOverride ?? agentsMdPath();
  const hasBlock = existsSync(agentsPath) && readFileSync(agentsPath, "utf8").includes("pi-tokensave:start");
  lines.push(hasBlock ? `✔ AGENTS.md rules block present (${agentsPath})` : `✘ AGENTS.md rules block missing. Run /tokensave-rules-install.`);

  lines.push(`Mode: ${getState().mode}`);

  if (hasTokensaveMcpIntegration(mcpPathOverride)) {
    lines.push(
      "",
      "Note: a TokenSave MCP server is registered in Pi's mcp.json.",
      "pi-tokensave does not use MCP and works independently of it.",
      "To remove only the Pi MCP integration, run: tokensave uninstall --agent pi",
      "(Do not run 'tokensave uninstall' without --agent; that removes every agent integration.)",
    );
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

export function registerTokensaveCommands(
  pi: ExtensionAPI,
  getState: GetState,
  setMode: SetMode,
  modePathOverride?: string,
  agentsPathOverride?: string,
  mcpPathOverride?: string,
): void {
  pi.registerCommand("tokensave-status", {
    description: "Show TokenSave binary, project init, and graph status",
    handler: async (_args, ctx) => handleStatus(ctx),
  });

  pi.registerCommand("tokensave-init", {
    description: "Initialize TokenSave for the current project (asks for confirmation)",
    handler: async (_args, ctx) => handleInit(ctx),
  });

  pi.registerCommand("tokensave-sync", {
    description: "Incrementally sync the TokenSave index for the current project",
    handler: async (_args, ctx) => handleSync(ctx),
  });

  pi.registerCommand("tokensave-mode", {
    description: "Show or set enforcement mode: prefer | enforce",
    getArgumentCompletions: (prefix: string) => {
      const options = ["prefer", "enforce"].filter((option) => option.startsWith(prefix));
      return options.length > 0 ? options.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const value = args.trim();
      if (!value) {
        ctx.ui.notify(`Current mode: ${getState().mode}`, "info");
        return;
      }
      if (value !== "prefer" && value !== "enforce") {
        ctx.ui.notify("Usage: /tokensave-mode prefer|enforce", "error");
        return;
      }
      setMode(value);
      savePersistedMode(value, modePathOverride);
      ctx.ui.notify(`pi-tokensave mode set to '${value}' (persisted to ${modePathOverride ?? modeConfigPath()}).`, "info");
    },
  });

  pi.registerCommand("tokensave-rules-install", {
    description: "Install/update the pi-tokensave instructions block in ~/.pi/agent/AGENTS.md",
    handler: async (_args, ctx) => {
      const { changed } = installRulesBlock(agentsPathOverride);
      const path = agentsPathOverride ?? agentsMdPath();
      ctx.ui.notify(
        changed
          ? `Installed pi-tokensave rules in ${path}. Run /reload or start a new session to apply immediately.`
          : "pi-tokensave rules already up to date.",
        "info",
      );
    },
  });

  pi.registerCommand("tokensave-rules-remove", {
    description: "Remove the pi-tokensave instructions block from ~/.pi/agent/AGENTS.md",
    handler: async (_args, ctx) => {
      const { changed } = removeRulesBlock(agentsPathOverride);
      const path = agentsPathOverride ?? agentsMdPath();
      ctx.ui.notify(changed ? `Removed pi-tokensave rules from ${path}.` : "No pi-tokensave rules block found.", "info");
    },
  });

  pi.registerCommand("tokensave-doctor", {
    description: "Diagnose TokenSave binary, project init, rules block, mode, and accidental MCP integration",
    handler: async (_args, ctx) => handleDoctor(ctx, getState, agentsPathOverride, mcpPathOverride),
  });
}
