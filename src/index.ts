/**
 * pi-tokensave: native Pi extension that makes the agent use the local
 * TokenSave CLI for code intelligence before grep/find/manual exploration.
 *
 * No MCP. No `tokensave serve`. No direct database access. Read-only tools
 * only — code changes still go through Pi's normal edit/write tools.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTokensaveCommands } from "./commands.ts";
import { detectSearchCandidate, evaluateGuard, type GuardableToolName } from "./guard.ts";
import { isProjectInitialized, resolveProjectRoot } from "./project.ts";
import { checkTokensaveAvailable } from "./runner.ts";
import { buildRulesBlock, installRulesBlock } from "./rules.ts";
import { createSessionState, loadPersistedMode, wasCandidateConsulted, type TokensaveSessionState } from "./state.ts";
import { registerTokensaveTools } from "./tools.ts";

const GUARDED_TOOLS = new Set<GuardableToolName>(["bash", "grep", "find"]);

export default function pluginTokensave(pi: ExtensionAPI): void {
  let state: TokensaveSessionState = createSessionState(loadPersistedMode());

  pi.on("session_start", async (_event, _ctx) => {
    state = createSessionState(loadPersistedMode());
    // Idempotent: safe to run on every session start, only writes on change.
    installRulesBlock();
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
    if (!GUARDED_TOOLS.has(event.toolName as GuardableToolName)) return;
    const toolName = event.toolName as GuardableToolName;

    if (state.binaryAvailable === undefined) {
      state.binaryAvailable = await checkTokensaveAvailable();
    }

    if (state.mode === "prefer") {
      maybeWarnManualExploration(toolName, event.input, ctx, state);
      return;
    }

    const root = resolveProjectRoot(ctx.cwd);
    const projectInitialized = isProjectInitialized(root);

    const decision = evaluateGuard({
      toolName,
      input: event.input,
      mode: state.mode,
      tokensaveAvailable: state.binaryAvailable,
      projectInitialized,
      wasConsulted: (candidate) => wasCandidateConsulted(state, candidate),
    });

    if (decision.block) {
      return { block: true, reason: decision.reason };
    }
  });

  pi.on("before_agent_start", (event) => {
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
