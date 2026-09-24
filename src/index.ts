/**
 * pi-tokensave: native Pi extension that makes the agent use the local
 * TokenSave CLI for code intelligence before grep/find/manual exploration.
 *
 * Read-only tools only — code changes still go through Pi's normal edit/write
 * tools.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBranchIndexLifecycle } from "./branch-lifecycle.ts";
import { registerTokensaveCommands } from "./commands.ts";
import { detectSearchCandidate, evaluateGuard, type GuardableToolName } from "./guard.ts";
import { isProjectInitialized, resolveProjectRoot } from "./project.ts";
import { checkTokensaveAvailable } from "./runner.ts";
import { buildRulesBlock, installRulesBlock } from "./rules.ts";
import { createSessionState, loadPersistedConfig, wasCandidateConsulted, type TokensaveSessionState } from "./state.ts";
import { registerTokensaveTools } from "./tools.ts";

const GUARDED_TOOLS = new Set<GuardableToolName>(["bash", "grep", "find"]);
const TOKENSAVE_TOOL_PREFIX = "tokensave_";

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
  let config = loadPersistedConfig();
  let state: TokensaveSessionState = createSessionState(config.mode);
  const branchReconciliation = createBranchReconciliation(pi, () => config, () => state);

  pi.on("session_start", async (_event, ctx) => {
    config = loadPersistedConfig();
    state = createSessionState(config.mode);
    branchReconciliation.reset();
    // The global block is conditional on .tokensave presence, so it is safe to
    // refresh for every session even though AGENTS.md is shared by all projects.
    installRulesBlock();
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
    const cwd = event.systemPromptOptions?.cwd;
    if (!cwd || !isProjectInitialized(resolveProjectRoot(cwd))) return;

    const contextFiles = event.systemPromptOptions?.contextFiles ?? [];
    const alreadyLoaded = contextFiles.some(
      (file) => typeof file.content === "string" && file.content.includes("pi-tokensave:start"),
    );
    if (alreadyLoaded) return;

    // Not yet present in any loaded context file for this run (e.g. Pi
    // loaded context before installRulesBlock() ran, or AGENTS.md hasn't
    // been re-read since). Inject for this turn and try again on the next
    // run — do not gate on a one-shot session flag.
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
