/**
 * pi-tokensave: native Pi extension that makes the agent use the local
 * TokenSave CLI for code intelligence before grep/find/manual exploration.
 *
 * Read-only tools only — code changes still go through Pi's normal edit/write
 * tools.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAgentDir } from "./agent-dir.ts";
import { createBranchIndexLifecycle } from "./branch-lifecycle.ts";
import { registerTokensaveCommands } from "./commands.ts";
import { detectSearchCandidate, evaluateGuard, type GuardableToolName } from "./guard.ts";
import { isProjectInitialized, resolveProjectRoot } from "./project.ts";
import { checkTokensaveAvailable } from "./runner.ts";
import { agentsMdPath, buildRulesBlock, installRulesBlock } from "./rules.ts";
import {
  createSessionState,
  loadPersistedConfig,
  modeConfigPath,
  wasCandidateConsulted,
  type TokensaveSessionState,
} from "./state.ts";
import { registerTokensaveTools } from "./tools.ts";

const GUARDED_TOOLS = new Set<GuardableToolName>(["bash", "grep", "find", "anchor_grep"]);
const TOKENSAVE_TOOL_PREFIX = "tokensave_";
const RULES_MARKER = "pi-tokensave:start";
/** Rendered as `<tokensave>...</tokensave>` in the system prompt. */
const RULES_SECTION_NAME = "tokensave";

function createBranchReconciliation(
  pi: ExtensionAPI,
  getConfig: () => { autoManageBranches: boolean },
  getState: () => TokensaveSessionState,
) {
  const lifecycle = createBranchIndexLifecycle();
  const warnedRoots = new Set<string>();

  return {
    reset() {
      lifecycle.reset();
      warnedRoots.clear();
    },
    async run(ctx: ExtensionContext): Promise<void> {
      if (!getConfig().autoManageBranches) return;

      const root = resolveProjectRoot(ctx.cwd);
      if (!isProjectInitialized(root)) return;

      const state = getState();
      if (state.binaryAvailable === undefined) {
        state.binaryAvailable = await checkTokensaveAvailable();
      }
      if (!state.binaryAvailable) return;

      const result = await lifecycle.reconcile(pi, root);
      if (result.warnings.length > 0 && !warnedRoots.has(root)) {
        warnedRoots.add(root);
        ctx.ui.notify(
          `pi-tokensave could not reconcile branch indexes:\n${result.warnings.join("\n")}`,
          "warning",
        );
      }
    },
  };
}

export default function pluginTokensave(pi: ExtensionAPI): void {
  // Sessions created with an explicit agentDir keep their settings and AGENTS.md
  // there, not in ~/.pi/agent. `pi.agentDir` is the same directory ctx reports later.
  let config = loadPersistedConfig(modeConfigPath(resolveAgentDir(pi)));
  let state: TokensaveSessionState = createSessionState(config.mode);
  const branchReconciliation = createBranchReconciliation(pi, () => config, () => state);

  pi.on("session_start", async (_event, ctx) => {
    const agentDir = resolveAgentDir(ctx);
    config = loadPersistedConfig(modeConfigPath(agentDir));
    state = createSessionState(config.mode);
    branchReconciliation.reset();
    // The global block is conditional on .tokensave presence, so it is safe to
    // refresh for every session even though AGENTS.md is shared by all projects.
    installRulesBlock(agentsMdPath(agentDir));
    // A sync after long drift can take seconds, so session start does not wait
    // for it. A TokenSave tool call joins the reconciliation still in flight.
    // The catch covers a ctx made stale by a session switch before it settles.
    void branchReconciliation.run(ctx).catch(() => {});
  });

  registerTokensaveTools(pi, () => state);
  registerTokensaveCommands(
    pi,
    () => state,
    (mode) => {
      state.mode = mode;
    },
  );

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName.startsWith(TOKENSAVE_TOOL_PREFIX)) {
      await branchReconciliation.run(ctx);
      return;
    }
    if (!GUARDED_TOOLS.has(event.toolName as GuardableToolName)) return;
    const toolName = event.toolName as GuardableToolName;

    const root = resolveProjectRoot(ctx.cwd);
    if (!isProjectInitialized(root)) return;

    if (state.binaryAvailable === undefined) {
      state.binaryAvailable = await checkTokensaveAvailable();
    }

    if (state.mode === "prefer") {
      maybeWarnManualExploration(toolName, event.input, ctx, state);
      return;
    }

    const decision = evaluateGuard({
      toolName,
      input: event.input,
      mode: state.mode,
      tokensaveAvailable: state.binaryAvailable,
      projectInitialized: true,
      wasConsulted: (candidate) => wasCandidateConsulted(state, candidate),
    });

    if (decision.block) {
      return { block: true, reason: decision.reason };
    }
  });

  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    const cwd = options?.cwd;
    if (!cwd || !isProjectInitialized(resolveProjectRoot(cwd))) return;

    // The rendered prompt already holds the block when a loaded AGENTS.md carries
    // it, or when a subagent embeds its parent's prompt (pi-subagents append mode).
    const contextFiles = options.contextFiles ?? [];
    const alreadyLoaded =
      event.systemPrompt.includes(RULES_MARKER) ||
      contextFiles.some((file) => typeof file.content === "string" && file.content.includes(RULES_MARKER));
    if (alreadyLoaded) return;

    // Not yet present: Pi loaded context before installRulesBlock() ran, or the
    // session loads no context files (pi-subagents children). Inject for this run
    // and check again on the next one; do not gate on a one-shot session flag.
    //
    // A named section leaves the rest of the prompt structured. Returning a full
    // `systemPrompt` would replace the prompt for the whole run instead. That
    // fallback remains for hosts without sections, and for a prompt an earlier
    // handler already replaced, because a replaced prompt ignores sections.
    if (options.sections && options.forceSystemPrompt === undefined) {
      options.sections[RULES_SECTION_NAME] = buildRulesBlock();
      return;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${buildRulesBlock()}` };
  });
}

function maybeWarnManualExploration(
  toolName: GuardableToolName,
  input: unknown,
  ctx: { cwd: string; ui: { notify: (message: string, level?: "info" | "warning" | "error") => void } },
  state: TokensaveSessionState,
): void {
  if (state.warnedManualExplorationOnce) return;
  if (state.binaryAvailable === false) return;
  if (!isProjectInitialized(resolveProjectRoot(ctx.cwd))) return;

  const candidate = detectSearchCandidate(toolName, input);
  if (!candidate || wasCandidateConsulted(state, candidate)) return;

  state.warnedManualExplorationOnce = true;
  ctx.ui.notify(
    `pi-tokensave: this looks like symbol discovery for '${candidate}'. Consider tokensave_find_symbol first.`,
    "info",
  );
}
