import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAgentDir } from "../src/agent-dir.ts";

const ENV = "PI_CODING_AGENT_DIR";

function withAgentDirEnv(value: string | undefined, run: () => void): void {
  const previous = process.env[ENV];
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  }
}

test("resolveAgentDir prefers the agentDir the host reports", () => {
  withAgentDirEnv("/env/agent", () => {
    assert.equal(resolveAgentDir({ agentDir: "/session/agent" }), "/session/agent");
  });
});

test("resolveAgentDir falls back to PI_CODING_AGENT_DIR on hosts without agentDir", () => {
  withAgentDirEnv("/env/agent", () => {
    assert.equal(resolveAgentDir({}), "/env/agent");
    assert.equal(resolveAgentDir(), "/env/agent");
  });
  withAgentDirEnv("~/custom-agent", () => {
    assert.equal(resolveAgentDir({}), join(homedir(), "custom-agent"));
  });
});

test("resolveAgentDir defaults to ~/.pi/agent", () => {
  withAgentDirEnv(undefined, () => {
    assert.equal(resolveAgentDir({ agentDir: "" }), join(homedir(), ".pi", "agent"));
    assert.equal(resolveAgentDir(), join(homedir(), ".pi", "agent"));
  });
});
