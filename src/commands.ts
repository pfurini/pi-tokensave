/**
 * Slash commands: status, init, sync, mode switch, rules install/remove, doctor.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveAgentDir } from "./agent-dir.ts";
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

async function handleDoctor(
  ctx: ExtensionCommandContext,
  getState: GetState,
  agentsPathOverride?: string,
): Promise<void> {
  const root = resolveProjectRoot(ctx.cwd);
  const lines: string[] = [];

  const binaryPath = resolveTokensaveBinary();
  const available = await checkTokensaveAvailable();
  lines.push(available ? `✔ Binary found: ${binaryPath}` : `✘ Binary not found: ${binaryPath}`);

  const initialized = isProjectInitialized(root);
  lines.push(initialized ? `✔ Project initialized (${join(root, ".tokensave")})` : "✘ Project not initialized. Run /tokensave-init.");

  const agentsPath = agentsPathOverride ?? agentsMdPath(resolveAgentDir(ctx));
  const hasBlock = existsSync(agentsPath) && readFileSync(agentsPath, "utf8").includes("pi-tokensave:start");
  lines.push(hasBlock ? `✔ AGENTS.md rules block present (${agentsPath})` : `✘ AGENTS.md rules block missing. Run /tokensave-rules-install.`);

  lines.push(`Mode: ${getState().mode}`);

  ctx.ui.notify(lines.join("\n"), "info");
}

export function registerTokensaveCommands(
  pi: ExtensionAPI,
  getState: GetState,
  setMode: SetMode,
  modePathOverride?: string,
  agentsPathOverride?: string,
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
      const modePath = modePathOverride ?? modeConfigPath(resolveAgentDir(ctx));
      savePersistedMode(value, modePath);
      ctx.ui.notify(`pi-tokensave mode set to '${value}' (persisted to ${modePath}).`, "info");
    },
  });

  pi.registerCommand("tokensave-rules-install", {
    description: "Install/update the pi-tokensave instructions block in the agent directory's AGENTS.md",
    handler: async (_args, ctx) => {
      const path = agentsPathOverride ?? agentsMdPath(resolveAgentDir(ctx));
      const { changed } = installRulesBlock(path);
      ctx.ui.notify(
        changed
          ? `Installed pi-tokensave rules in ${path}. Run /reload or start a new session to apply immediately.`
          : "pi-tokensave rules already up to date.",
        "info",
      );
    },
  });

  pi.registerCommand("tokensave-rules-remove", {
    description: "Remove the pi-tokensave instructions block from the agent directory's AGENTS.md",
    handler: async (_args, ctx) => {
      const path = agentsPathOverride ?? agentsMdPath(resolveAgentDir(ctx));
      const { changed } = removeRulesBlock(path);
      ctx.ui.notify(changed ? `Removed pi-tokensave rules from ${path}.` : "No pi-tokensave rules block found.", "info");
    },
  });

  pi.registerCommand("tokensave-doctor", {
    description: "Diagnose TokenSave binary, project init, rules block, and mode",
    handler: async (_args, ctx) => handleDoctor(ctx, getState, agentsPathOverride),
  });
}
