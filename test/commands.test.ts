import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTokensaveCommands } from "../src/commands.ts";
import { setExecFileImplForTest } from "../src/runner.ts";
import { installRulesBlock } from "../src/rules.ts";
import type { TokensaveMode } from "../src/state.ts";

type Cb = (error: (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null, stdout: string, stderr: string) => void;

function fakePi() {
  const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
  return {
    commands,
    registerCommand(name: string, def: any) {
      commands[name] = def;
    },
  } as any;
}

function fakeCtx(cwd: string, confirmAnswer = true) {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    cwd,
    ui: {
      notify: (message: string, level = "info") => notifications.push({ message, level }),
      confirm: async () => confirmAnswer,
    },
    notifications,
  } as any;
}

test.afterEach(() => setExecFileImplForTest(undefined));

test("tokensave-status notifies binary-missing when TokenSave is absent", async () => {
  setExecFileImplForTest((_f, _a, _o, cb: Cb) => {
    const err = new Error("not found") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    cb(err, "", "");
    return {};
  });

  const pi = fakePi();
  let state = { mode: "enforce" as TokensaveMode };
  registerTokensaveCommands(pi, () => state, (m) => (state.mode = m));

  const ctx = fakeCtx(mkdtempSync(join(tmpdir(), "pi-tokensave-cmd-")));
  await pi.commands["tokensave-status"].handler("", ctx);

  assert.ok(ctx.notifications.some((n: any) => /not found/i.test(n.message)));
});

test("tokensave-init asks for confirmation before running init", async () => {
  let ranInit = false;
  setExecFileImplForTest((_f, args: string[], _o, cb: Cb) => {
    if (args[0] === "init") ranInit = true;
    cb(null, "Initialized TokenSave", "");
    return {};
  });

  const pi = fakePi();
  const state = { mode: "enforce" as TokensaveMode };
  registerTokensaveCommands(pi, () => state, (m) => (state.mode = m));

  const dir = mkdtempSync(join(tmpdir(), "pi-tokensave-cmd-"));
  const ctx = fakeCtx(dir, true);
  await pi.commands["tokensave-init"].handler("", ctx);

  assert.equal(ranInit, true);
});

test("tokensave-init does not run when the user declines confirmation", async () => {
  let ranInit = false;
  setExecFileImplForTest((_f, args: string[], _o, cb: Cb) => {
    if (args[0] === "init") ranInit = true;
    cb(null, "", "");
    return {};
  });

  const pi = fakePi();
  const state = { mode: "enforce" as TokensaveMode };
  registerTokensaveCommands(pi, () => state, (m) => (state.mode = m));

  const dir = mkdtempSync(join(tmpdir(), "pi-tokensave-cmd-"));
  const ctx = fakeCtx(dir, false);
  await pi.commands["tokensave-init"].handler("", ctx);

  assert.equal(ranInit, false);
  assert.ok(ctx.notifications.some((n: any) => /cancelled/i.test(n.message)));
});

test("tokensave-mode reports current mode with no args and persists a new one", async () => {
  const pi = fakePi();
  const state = { mode: "enforce" as TokensaveMode };
  const modePath = join(mkdtempSync(join(tmpdir(), "pi-tokensave-mode-")), "mode.json");
  registerTokensaveCommands(pi, () => state, (m) => (state.mode = m), modePath);

  const ctx = fakeCtx("/tmp");
  await pi.commands["tokensave-mode"].handler("", ctx);
  assert.ok(ctx.notifications.some((n: any) => /Current mode: enforce/.test(n.message)));

  await pi.commands["tokensave-mode"].handler("prefer", ctx);
  assert.equal(state.mode, "prefer");
  assert.ok(existsSync(modePath));
  assert.deepEqual(JSON.parse(readFileSync(modePath, "utf8")), { mode: "prefer" });
});

test("tokensave-mode rejects invalid values", async () => {
  const pi = fakePi();
  const state = { mode: "enforce" as TokensaveMode };
  registerTokensaveCommands(pi, () => state, (m) => (state.mode = m));

  const ctx = fakeCtx("/tmp");
  await pi.commands["tokensave-mode"].handler("bogus", ctx);
  assert.equal(state.mode, "enforce");
  assert.ok(ctx.notifications.some((n: any) => n.level === "error"));
});

test("tokensave-rules-install and tokensave-rules-remove round-trip", async () => {
  const pi = fakePi();
  const state = { mode: "enforce" as TokensaveMode };
  const agentsPath = join(mkdtempSync(join(tmpdir(), "pi-tokensave-agents-")), "AGENTS.md");
  registerTokensaveCommands(pi, () => state, (m) => (state.mode = m), undefined, agentsPath);

  const ctx = fakeCtx("/tmp");
  await pi.commands["tokensave-rules-install"].handler("", ctx);
  await pi.commands["tokensave-rules-remove"].handler("", ctx);

  assert.ok(ctx.notifications.some((n: any) => /Installed/.test(n.message)));
  assert.ok(ctx.notifications.some((n: any) => /Removed/.test(n.message)));
});

test("tokensave-doctor reports mode and rules-block presence", async () => {
  setExecFileImplForTest((_f, args: string[], _o, cb: Cb) => {
    cb(args[0] === "--version" ? null : new Error("unused"), "tokensave 7.0.3", "");
    return {};
  });

  const agentsPath = join(mkdtempSync(join(tmpdir(), "pi-tokensave-agents-")), "AGENTS.md");
  installRulesBlock(agentsPath); // isolated tmp file, never touches the real ~/.pi/agent/AGENTS.md

  const pi = fakePi();
  const state = { mode: "prefer" as TokensaveMode };
  registerTokensaveCommands(pi, () => state, (m) => (state.mode = m), undefined, agentsPath);

  const ctx = fakeCtx(mkdtempSync(join(tmpdir(), "pi-tokensave-cmd-")));
  await pi.commands["tokensave-doctor"].handler("", ctx);

  const report = ctx.notifications[0]?.message ?? "";
  assert.ok(report.includes("Mode: prefer"));
  assert.ok(report.includes("AGENTS.md rules block present"));
});

test("mode, rules, and doctor commands use the session agentDir when no override is given", async () => {
  setExecFileImplForTest((_f, _args: string[], _o, cb: Cb) => {
    cb(null, "tokensave 7.12.1", "");
    return {};
  });

  const agentDir = mkdtempSync(join(tmpdir(), "pi-tokensave-agentdir-"));
  const pi = fakePi();
  const state = { mode: "enforce" as TokensaveMode };
  registerTokensaveCommands(pi, () => state, (m) => (state.mode = m));

  const ctx = Object.assign(fakeCtx(mkdtempSync(join(tmpdir(), "pi-tokensave-cmd-"))), { agentDir });

  await pi.commands["tokensave-mode"].handler("prefer", ctx);
  assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "pi-tokensave.json"), "utf8")), { mode: "prefer" });

  await pi.commands["tokensave-rules-install"].handler("", ctx);
  assert.ok(readFileSync(join(agentDir, "AGENTS.md"), "utf8").includes("pi-tokensave:start"));

  await pi.commands["tokensave-doctor"].handler("", ctx);
  const report = ctx.notifications.at(-1)?.message ?? "";
  assert.ok(report.includes(`AGENTS.md rules block present (${join(agentDir, "AGENTS.md")})`));
});
