/**
 * `before_agent_start` rule-injection behavior: the managed rules block must
 * be injected on every agent run until it is actually present in a loaded
 * context file, not gated by a one-shot per-session flag.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pluginTokensave from "../src/index.ts";
import { setExecFileImplForTest } from "../src/runner.ts";

type Cb = (error: (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null, stdout: string, stderr: string) => void;

type Handler = (event: any, ctx: any) => any;

function fakePi() {
  const handlers: Record<string, Handler> = {};
  const tools: Record<string, unknown> = {};
  const commands: Record<string, unknown> = {};
  return {
    handlers,
    on(event: string, handler: Handler) {
      handlers[event] = handler;
    },
    registerTool(def: any) {
      tools[def.name] = def;
    },
    registerCommand(name: string, def: any) {
      commands[name] = def;
    },
  } as unknown as ExtensionAPI & { handlers: Record<string, Handler> };
}

function baseSystemPromptOptions(cwd: string, contextFiles: Array<{ path: string; content: string }> = []) {
  return { cwd, contextFiles };
}

function initializedProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-tokensave-index-"));
  mkdirSync(join(dir, ".tokensave"));
  return dir;
}

test("before_agent_start injects the rules block when absent from loaded context files, on every call", async () => {
  const pi = fakePi();
  pluginTokensave(pi);
  const projectDir = initializedProjectDir();

  const event1 = {
    prompt: "hello",
    systemPrompt: "base prompt",
    systemPromptOptions: baseSystemPromptOptions(projectDir, [{ path: "/AGENTS.md", content: "unrelated instructions" }]),
  };
  const result1 = await pi.handlers.before_agent_start(event1, {});
  assert.ok(result1?.systemPrompt.includes("pi-tokensave:start"));

  const event2 = {
    prompt: "hello again",
    systemPrompt: "base prompt",
    systemPromptOptions: baseSystemPromptOptions(projectDir, [{ path: "/AGENTS.md", content: "unrelated instructions" }]),
  };
  const result2 = await pi.handlers.before_agent_start(event2, {});
  assert.ok(result2?.systemPrompt.includes("pi-tokensave:start"));
});

test("before_agent_start does not duplicate injection once a loaded context file already contains the block", async () => {
  const pi = fakePi();
  pluginTokensave(pi);
  const projectDir = initializedProjectDir();

  const event = {
    prompt: "hello",
    systemPrompt: "base prompt",
    systemPromptOptions: baseSystemPromptOptions(projectDir, [
      { path: "/AGENTS.md", content: "some text\n<!-- pi-tokensave:start -->\nalready loaded\n<!-- pi-tokensave:end -->\n" },
    ]),
  };

  const result = await pi.handlers.before_agent_start(event, {});
  assert.equal(result, undefined);
});

test("before_agent_start skips rule injection outside TokenSave projects", async () => {
  const pi = fakePi();
  pluginTokensave(pi);
  const projectDir = mkdtempSync(join(tmpdir(), "pi-tokensave-index-"));
  const event = {
    prompt: "hello",
    systemPrompt: "base prompt",
    systemPromptOptions: baseSystemPromptOptions(projectDir),
  };

  const result = await pi.handlers.before_agent_start(event, {});
  assert.equal(result, undefined);
});

test("guarded tool calls do not probe the TokenSave binary outside initialized projects", async () => {
  const pi = fakePi();
  pluginTokensave(pi);
  let processCount = 0;
  setExecFileImplForTest((_file, _args: string[], _options, cb: Cb) => {
    processCount += 1;
    cb(null, "tokensave 7.0.0", "");
    return {};
  });

  const projectDir = mkdtempSync(join(tmpdir(), "pi-tokensave-index-"));
  const result = await pi.handlers.tool_call(
    { toolName: "bash", input: { command: 'rg "WellModel" .' } },
    { cwd: projectDir, ui: { notify: () => {} } },
  );

  assert.equal(result, undefined);
  assert.equal(processCount, 0);
});

test.afterEach(() => setExecFileImplForTest(undefined));

test("enforce mode blocks a symbol search through anchor_grep but allows a config-file search", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-tokensave-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;
  setExecFileImplForTest((_file, _args: string[], _options, cb: Cb) => {
    cb(null, "tokensave 7.12.1", "");
    return {};
  });

  try {
    const pi = fakePi();
    pluginTokensave(pi);
    const ctx = { cwd: initializedProjectDir(), ui: { notify: () => {} } };

    const blocked = await pi.handlers.tool_call({ toolName: "anchor_grep", input: { pattern: "WellModel" } }, ctx);
    assert.equal(blocked?.block, true);

    const config = await pi.handlers.tool_call(
      { toolName: "anchor_grep", input: { pattern: "WellModel", path: "config/app.yaml" } },
      ctx,
    );
    assert.equal(config, undefined);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("tool_call in prefer mode does not recommend a TokenSave tool when the binary is unavailable (ENOENT)", async () => {
  // Force pi-tokensave's persisted mode ('prefer') to load from an isolated
  // fake home directory instead of the real ~/.pi/agent/pi-tokensave.json.
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-tokensave-home-"));
  mkdirSync(join(fakeHome, ".pi", "agent"), { recursive: true });
  writeFileSync(join(fakeHome, ".pi", "agent", "pi-tokensave.json"), JSON.stringify({ mode: "prefer" }), "utf8");
  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;

  setExecFileImplForTest((_file, _args: string[], _options, cb: Cb) => {
    const err = new Error("not found") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    cb(err, "", "");
    return {};
  });

  try {
    const pi = fakePi();
    pluginTokensave(pi);

    const projectDir = mkdtempSync(join(tmpdir(), "pi-tokensave-index-"));
    mkdirSync(join(projectDir, ".tokensave"));

    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      cwd: projectDir,
      ui: { notify: (message: string, level = "info") => notifications.push({ message, level }) },
    };

    await pi.handlers.session_start({}, {});
    const result = await pi.handlers.tool_call({ toolName: "bash", input: { command: 'rg "WellModel" .' } }, ctx);

    assert.equal(result, undefined);
    assert.equal(notifications.length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("autoManageBranches starts reconciling at session start without blocking it, and a TokenSave tool waits for it", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-tokensave-home-"));
  mkdirSync(join(fakeHome, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(fakeHome, ".pi", "agent", "pi-tokensave.json"),
    JSON.stringify({ autoManageBranches: true }),
    "utf8",
  );
  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;

  const tokensaveCommands: string[][] = [];
  let releaseSync: (() => void) | undefined;
  let holdSync = true;
  setExecFileImplForTest((_file, args: string[], _options, cb: Cb) => {
    if (args[0] !== "--version") tokensaveCommands.push(args);
    if (args[0] === "sync" && holdSync) {
      releaseSync = () => cb(null, "ok", "");
      return {};
    }
    cb(null, args[0] === "--version" ? "tokensave 7.4.0" : "ok", "");
    return {};
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const steps = () => tokensaveCommands.map((args) => (args[0] === "branch" ? `branch ${args[1]}` : args[0]));

  try {
    let refs = `*\trefs/heads/main\t${"a".repeat(40)}`;
    const pi = fakePi();
    pi.exec = async () => ({ code: 0, stdout: refs, stderr: "", killed: false });
    pluginTokensave(pi);

    const projectDir = initializedProjectDir();
    const ctx = { cwd: projectDir, ui: { notify: () => {} } };

    await pi.handlers.session_start({}, ctx);
    await flush();
    assert.deepEqual(steps(), ["branch add", "sync"], "session start returns while the sync still runs");

    let toolCallSettled = false;
    const toolCall = Promise.resolve(pi.handlers.tool_call({ toolName: "tokensave_status", input: {} }, ctx)).then(() => {
      toolCallSettled = true;
    });
    await flush();
    assert.equal(toolCallSettled, false, "a TokenSave tool call waits for the reconciliation in flight");

    holdSync = false;
    releaseSync?.();
    await toolCall;
    assert.deepEqual(steps(), ["branch add", "sync", "branch gc"], "the tool call joins the run instead of starting another");

    await pi.handlers.tool_call({ toolName: "tokensave_status", input: {} }, ctx);
    assert.equal(tokensaveCommands.length, 3, "unchanged refs should stay cached");

    refs = `*\trefs/heads/main\t${"b".repeat(40)}`;
    await pi.handlers.tool_call({ toolName: "tokensave_status", input: {} }, ctx);
    assert.equal(tokensaveCommands.length, 6, "a new commit should sync before the tool runs");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
