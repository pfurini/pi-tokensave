import test from "node:test";
import assert from "node:assert/strict";
import { evaluateGuard, extractBashSearchCandidate, extractSymbolCandidate } from "../src/guard.ts";

function baseParams(overrides: Partial<Parameters<typeof evaluateGuard>[0]> = {}) {
  return {
    toolName: "bash" as const,
    input: {},
    mode: "enforce" as const,
    tokensaveAvailable: true,
    projectInitialized: true,
    wasConsulted: () => false,
    ...overrides,
  };
}

test("extractSymbolCandidate recognizes bare identifiers", () => {
  assert.equal(extractSymbolCandidate("WellModel"), "WellModel");
  assert.equal(extractSymbolCandidate("generate_node_content"), "generate_node_content");
});

test("extractSymbolCandidate recognizes declaration-style patterns", () => {
  assert.equal(extractSymbolCandidate("class WellModel"), "WellModel");
});

test("extractSymbolCandidate recognizes wildcard file-name searches", () => {
  assert.equal(extractSymbolCandidate("*wellmodel*"), "wellmodel");
});

test("extractSymbolCandidate ignores complex regex and short tokens", () => {
  assert.equal(extractSymbolCandidate("^(foo|bar)\\d+$"), undefined);
  assert.equal(extractSymbolCandidate("ab"), undefined);
});

test("extractBashSearchCandidate parses rg/grep/find invocations", () => {
  assert.equal(extractBashSearchCandidate('rg "WellModel" .'), "WellModel");
  assert.equal(extractBashSearchCandidate('grep -R "class WellModel" .'), "WellModel");
  assert.equal(extractBashSearchCandidate('find . -iname "*wellmodel*"'), "wellmodel");
  assert.equal(extractBashSearchCandidate('rg "generate_node_content" backend'), "generate_node_content");
});

test("extractBashSearchCandidate allows git grep", () => {
  assert.equal(extractBashSearchCandidate('git grep "WellModel"'), undefined);
});

test("extractBashSearchCandidate allows complex pipelines", () => {
  assert.equal(extractBashSearchCandidate('rg "WellModel" . | wc -l'), undefined);
  assert.equal(extractBashSearchCandidate('rg "WellModel" . && echo done'), undefined);
});

test("extractBashSearchCandidate allows config/log/migration/markdown targets", () => {
  assert.equal(extractBashSearchCandidate('rg "WellModel" docs/notes.md'), undefined);
  assert.equal(extractBashSearchCandidate('rg "timeout" config.yaml'), undefined);
  assert.equal(extractBashSearchCandidate('rg "WellModel" db/migrations/'), undefined);
  assert.equal(extractBashSearchCandidate('grep "error" app.log'), undefined);
});

test("enforce mode blocks named-symbol search before TokenSave is consulted", () => {
  const decision = evaluateGuard(baseParams({ input: { command: 'rg "WellModel" .' } }));
  assert.equal(decision.block, true);
  assert.equal(decision.candidate, "WellModel");
});

test("enforce mode blocks the built-in grep tool equivalent", () => {
  const decision = evaluateGuard(
    baseParams({ toolName: "grep", input: { pattern: "WellModel", path: "." } }),
  );
  assert.equal(decision.block, true);
});

test("enforce mode allows search after TokenSave was consulted for that symbol", () => {
  const decision = evaluateGuard(
    baseParams({ input: { command: 'rg "WellModel" .' }, wasConsulted: (c) => c === "WellModel" }),
  );
  assert.equal(decision.block, false);
});

test("enforce mode allows fallback after TokenSave returned empty or errored (still counts as consulted)", () => {
  // The caller marks a query as consulted regardless of success/failure;
  // guard only checks whether it was consulted, not whether it succeeded.
  const decision = evaluateGuard(
    baseParams({ input: { command: 'rg "WellModel" .' }, wasConsulted: () => true }),
  );
  assert.equal(decision.block, false);
});

test("enforce mode allows complex regex", () => {
  const decision = evaluateGuard(baseParams({ input: { command: 'rg "^(foo|bar)\\\\d+$" .' } }));
  assert.equal(decision.block, false);
});

test("enforce mode allows git grep", () => {
  const decision = evaluateGuard(baseParams({ input: { command: 'git grep "WellModel"' } }));
  assert.equal(decision.block, false);
});

test("enforce mode allows logs and config files", () => {
  assert.equal(evaluateGuard(baseParams({ input: { command: 'grep "error" app.log' } })).block, false);
  assert.equal(evaluateGuard(baseParams({ input: { command: 'rg "timeout" config.yaml' } })).block, false);
});

test("enforce mode allows when TokenSave is not installed", () => {
  const decision = evaluateGuard(
    baseParams({ input: { command: 'rg "WellModel" .' }, tokensaveAvailable: false }),
  );
  assert.equal(decision.block, false);
});

test("enforce mode allows when project is not initialized", () => {
  const decision = evaluateGuard(
    baseParams({ input: { command: 'rg "WellModel" .' }, projectInitialized: false }),
  );
  assert.equal(decision.block, false);
});

test("prefer mode never blocks", () => {
  const decision = evaluateGuard(baseParams({ mode: "prefer", input: { command: 'rg "WellModel" .' } }));
  assert.equal(decision.block, false);
});
