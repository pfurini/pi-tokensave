/**
 * Execution-level tests: register the real Pi tools against a fake Pi API,
 * mock the CLI runner, and invoke each tool's `execute` function with real
 * TokenSave response-envelope shapes. No registered tool should ever throw
 * because an upstream result has an unexpected (but validly-JSON or
 * plain-text) shape.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTokensaveTools } from "../src/tools.ts";
import { setExecFileImplForTest } from "../src/runner.ts";
import { createSessionState } from "../src/state.ts";

type Cb = (error: (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null, stdout: string, stderr: string) => void;

type ToolResponder = (args: Record<string, unknown>) => { json?: unknown; text?: string } | undefined;

function envelope(text: string): string {
  return JSON.stringify({ content: [{ type: "text", text }] });
}

/** Wires setExecFileImplForTest to dispatch by underlying `tokensave tool <name>` name. */
function mockCli(responders: Record<string, ToolResponder>) {
  setExecFileImplForTest((_file, args: string[], _options, cb: Cb) => {
    const toolName = args[1];
    const argsJson = args[5] ?? "{}";
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    const responder = responders[toolName];
    if (!responder) {
      cb(null, envelope(JSON.stringify({ error: `no mock for tool '${toolName}'` })), "");
      return {};
    }
    const result = responder(parsed);
    if (!result) {
      cb(null, envelope(JSON.stringify({})), "");
      return {};
    }
    const text = result.text ?? JSON.stringify(result.json);
    cb(null, envelope(text), "");
    return {};
  });
}

function fakePi() {
  const tools: Record<string, any> = {};
  return {
    tools,
    registerTool(def: any) {
      tools[def.name] = def;
    },
  } as unknown as ExtensionAPI & { tools: Record<string, any> };
}

function fakeCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    ui: { notify: () => {}, confirm: async () => true },
  } as unknown as ExtensionContext;
}

function initializedProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-tokensave-exec-"));
  mkdirSync(join(dir, ".tokensave"));
  return dir;
}

async function execute(pi: ReturnType<typeof fakePi>, name: string, params: unknown, ctx: ExtensionContext) {
  const tool = pi.tools[name];
  assert.ok(tool, `tool '${name}' was not registered`);
  return tool.execute("call-1", params, undefined, () => {}, ctx);
}

test.afterEach(() => setExecFileImplForTest(undefined));

function setup() {
  const pi = fakePi();
  const state = createSessionState("enforce");
  registerTokensaveTools(pi, () => state);
  const dir = initializedProjectDir();
  const ctx = fakeCtx(dir);
  return { pi, ctx, state };
}

// ---------------------------------------------------------------------------
// tokensave_status: status object
// ---------------------------------------------------------------------------

test("tokensave_status renders a status object", async () => {
  const { pi, ctx } = setup();
  mockCli({
    status: () => ({ json: { node_count: 120, edge_count: 340, file_count: 12, db_size_bytes: 40960 } }),
  });

  const result = await execute(pi, "tokensave_status", {}, ctx);
  assert.match(result.content[0].text, /nodes: 120/);
});

test("tokensave_status does not launch a process outside initialized projects", async () => {
  const pi = fakePi();
  const state = createSessionState("enforce");
  registerTokensaveTools(pi, () => state);
  const ctx = fakeCtx(mkdtempSync(join(tmpdir(), "pi-tokensave-exec-")));
  let processCount = 0;
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    processCount += 1;
    cb(null, "tokensave 7.0.0", "");
    return {};
  });

  const result = await execute(pi, "tokensave_status", {}, ctx);
  assert.match(result.content[0].text, /not initialized/i);
  assert.equal(processCount, 0);
});

// ---------------------------------------------------------------------------
// tokensave_context: markdown response
// ---------------------------------------------------------------------------

test("tokensave_context renders a markdown response", async () => {
  const { pi, ctx } = setup();
  mockCli({ context: () => ({ text: "## Task context\n\nRelevant files: src/example.ts" }) });

  const result = await execute(pi, "tokensave_context", { task: "understand example" }, ctx);
  assert.match(result.content[0].text, /Task context/);
});

// ---------------------------------------------------------------------------
// tokensave_search: normal array vs literal object (issue #1)
// ---------------------------------------------------------------------------

test("tokensave_search renders the normal symbol-search array shape", async () => {
  const { pi, ctx } = setup();
  mockCli({
    search: () => ({ json: [{ name: "WellModel", kind: "class", file: "core/models/well_model.py", line: 4 }] }),
  });

  const result = await execute(pi, "tokensave_search", { query: "WellModel" }, ctx);
  assert.match(result.content[0].text, /WellModel/);
  assert.equal(result.details.ok, true);
});

test("tokensave_search renders the literal-search object shape without throwing", async () => {
  const { pi, ctx } = setup();
  mockCli({
    search: () => ({
      json: {
        literal: true,
        query: "text",
        count: 2,
        matches: [
          { file: "src/example.ts", line: 10, text: "runtime error text", enclosing: "example", enclosing_id: "abc" },
          { file: "src/other.ts", line: 20, text: "runtime error text again" },
        ],
      },
    }),
  });

  const result = await execute(pi, "tokensave_search", { query: "runtime error text", literal: true }, ctx);
  assert.match(result.content[0].text, /runtime error text/);
  assert.match(result.content[0].text, /src\/example\.ts:10/);
  assert.equal(result.details.ok, true);
});

// ---------------------------------------------------------------------------
// tokensave_symbol / implementations: object envelope (issue #2)
// ---------------------------------------------------------------------------

test("tokensave_symbol decodes the implementations object envelope without throwing", async () => {
  const { pi, ctx } = setup();
  mockCli({
    find_exact_symbol: () => ({ json: { count: 1, matches: [{ id: "n1", name: "Runner", kind: "interface", file: "src/runner.ts", line: 5 }] } }),
    body: () => ({ text: "No matching symbol body found." }),
    implementations: () => ({
      json: {
        match_count: 2,
        implementations: [
          { file: "src/impl_a.ts", signature: "class ImplA implements Runner" },
          { file: "src/impl_b.ts", signature: "class ImplB implements Runner" },
        ],
      },
    }),
  });

  const result = await execute(pi, "tokensave_symbol", { name: "Runner", includeImplementations: true }, ctx);
  assert.match(result.content[0].text, /Implementations \(2\)/);
  assert.match(result.content[0].text, /ImplA/);
});

test("tokensave_symbol handles TokenSave's plain-text no-match response for implementations", async () => {
  const { pi, ctx } = setup();
  mockCli({
    find_exact_symbol: () => ({ json: { count: 1, matches: [{ id: "n1", name: "Runner", kind: "interface", file: "src/runner.ts", line: 5 }] } }),
    body: () => ({ text: "No matching symbol body found." }),
    implementations: () => ({ text: "No implementations found." }),
  });

  const result = await execute(pi, "tokensave_symbol", { name: "Runner", includeImplementations: true }, ctx);
  assert.match(result.content[0].text, /No implementations found\./);
  assert.doesNotMatch(result.content[0].text, /undefined \(symbol\)/);
});

// ---------------------------------------------------------------------------
// tokensave_impact / affected: changed_files/affected_tests/count (issue #3)
// ---------------------------------------------------------------------------

test("tokensave_impact decodes the affected-tests object envelope without throwing", async () => {
  const { pi, ctx } = setup();
  mockCli({
    find_exact_symbol: () => ({ json: { count: 1, matches: [{ id: "n1", name: "Example", file: "src/example.ts" }] } }),
    impact: () => ({ json: { node_count: 1, nodes: [{ name: "Example", file: "src/example.ts", line: 1 }] } }),
    affected: () => ({ json: { changed_files: ["src/example.ts"], affected_tests: ["test/example.test.ts"], count: 1 } }),
  });

  const result = await execute(pi, "tokensave_impact", { name: "Example", includeTests: true }, ctx);
  assert.match(result.content[0].text, /Affected tests \(1\)/);
  assert.match(result.content[0].text, /test\/example\.test\.ts/);
});

// ---------------------------------------------------------------------------
// File-based tokensave_impact
// ---------------------------------------------------------------------------

test("tokensave_impact({ file }) performs file-scoped impact analysis instead of returning 'could not compute impact'", async () => {
  const { pi, ctx } = setup();
  mockCli({
    file_dependents: () => ({ json: { count: 1, dependents: [{ file: "src/consumer.ts", name: "Consumer" }] } }),
    diff_context: () => ({
      json: {
        changed_files: ["src/example.ts"],
        modified_symbols: [{ name: "example", kind: "function", file: "src/example.ts", line: 3 }],
        impacted_symbols_count: 0,
        impacted_symbols: [],
        affected_tests: [],
      },
    }),
  });

  const result = await execute(pi, "tokensave_impact", { file: "src/example.ts" }, ctx);
  assert.doesNotMatch(result.content[0].text, /Could not compute impact/);
  assert.match(result.content[0].text, /File dependents/);
  assert.match(result.content[0].text, /Consumer/);
});

test("tokensave_impact({ file, includeTests: true }) also reports affected tests", async () => {
  const { pi, ctx } = setup();
  mockCli({
    file_dependents: () => ({ json: { count: 0, dependents: [] } }),
    diff_context: () => ({ json: { changed_files: ["src/example.ts"], modified_symbols: [], impacted_symbols_count: 0, impacted_symbols: [], affected_tests: [] } }),
    affected: () => ({ json: { changed_files: ["src/example.ts"], affected_tests: ["test/example.test.ts"], count: 1 } }),
  });

  const result = await execute(pi, "tokensave_impact", { file: "src/example.ts", includeTests: true }, ctx);
  assert.match(result.content[0].text, /Affected tests \(1\)/);
  assert.match(result.content[0].text, /test\/example\.test\.ts/);
});

test("tokensave_impact({ name, includeTests: true }) resolves the symbol's file before requesting affected tests", async () => {
  const { pi, ctx } = setup();
  let affectedFilesRequested: unknown;
  mockCli({
    find_exact_symbol: () => ({ json: { count: 1, matches: [{ id: "n1", name: "ExampleService", file: "src/example_service.ts" }] } }),
    impact: () => ({ json: { node_count: 0, nodes: [] } }),
    affected: (args) => {
      affectedFilesRequested = args.files;
      return { json: { changed_files: ["src/example_service.ts"], affected_tests: ["test/example_service.test.ts"], count: 1 } };
    },
  });

  const result = await execute(pi, "tokensave_impact", { name: "ExampleService", includeTests: true }, ctx);
  assert.deepEqual(affectedFilesRequested, ["src/example_service.ts"]);
  assert.match(result.content[0].text, /test\/example_service\.test\.ts/);
});

// ---------------------------------------------------------------------------
// tokensave_find_symbol: exact-symbol filtering past many same-name fields
// ---------------------------------------------------------------------------

test("tokensave_find_symbol finds the real class definition after more than 20 same-name fields/methods", async () => {
  const { pi, ctx } = setup();
  const decoys = Array.from({ length: 25 }, (_, i) => ({
    id: `field-${i}`,
    name: "WellModel",
    kind: "field",
    file: `src/decoy_${i}.ts`,
    line: i,
  }));
  const classMatch = { id: "class-1", name: "WellModel", kind: "class", file: "core/models/well_model.py", line: 4, signature: "class WellModel(models.Model)" };

  mockCli({
    find_exact_symbol: () => ({ json: { count: decoys.length + 1, matches: [...decoys, classMatch] } }),
  });

  const result = await execute(pi, "tokensave_find_symbol", { name: "WellModel", kind: "class", limit: 20 }, ctx);
  assert.match(result.content[0].text, /core\/models\/well_model\.py/);
  assert.equal(result.details.shownCount, 1);
});

// ---------------------------------------------------------------------------
// tokensave_symbol: line vs start_line, node-object and node plain-text
// ---------------------------------------------------------------------------

test("tokensave_symbol supports 'line' from exact-symbol resolution", async () => {
  const { pi, ctx } = setup();
  mockCli({
    find_exact_symbol: () => ({ json: { count: 1, matches: [{ id: "n1", name: "Example", kind: "function", file: "src/example.ts", line: 42 }] } }),
    body: () => ({ text: "No matching symbol body found." }),
  });

  const result = await execute(pi, "tokensave_symbol", { name: "Example", includeBody: false }, ctx);
  assert.match(result.content[0].text, /src\/example\.ts:42/);
});

test("tokensave_symbol supports 'start_line' from a node-object lookup and resolves body via nodeId alone", async () => {
  const { pi, ctx } = setup();
  let bodySymbolRequested: unknown;
  mockCli({
    node: () => ({ json: { name: "Example", kind: "function", file: "src/example.ts", start_line: 7, qualified_name: "pkg.Example" } }),
    body: (args) => {
      bodySymbolRequested = args.symbol;
      return { json: { matches: [{ body: "function Example() {}" }] } };
    },
  });

  const result = await execute(pi, "tokensave_symbol", { nodeId: "n1" }, ctx);
  assert.match(result.content[0].text, /src\/example\.ts:7/);
  // Body lookup by nodeId prefers the resolved qualified_name over the bare
  // name, since the body tool accepts qualified names and this avoids
  // reopening an unrelated same-named symbol elsewhere in the project.
  assert.equal(bodySymbolRequested, "pkg.Example");
  assert.match(result.content[0].text, /function Example/);
});

test("tokensave_symbol handles a plain-text 'not found' node response without producing 'undefined (symbol)'", async () => {
  const { pi, ctx } = setup();
  mockCli({ node: () => ({ text: "Node not found." }) });

  const result = await execute(pi, "tokensave_symbol", { nodeId: "missing" }, ctx);
  assert.match(result.content[0].text, /Node not found\./);
  assert.doesNotMatch(result.content[0].text, /undefined \(symbol\)/);
});

test("tokensave_symbol surfaces a relationship-query failure compactly instead of silently ignoring it", async () => {
  const { pi, ctx } = setup();
  setExecFileImplForTest((_file, args: string[], _options, cb: Cb) => {
    const toolName = args[1];
    if (toolName === "callers") {
      const err = new Error("crash") as NodeJS.ErrnoException;
      cb(err, "", "internal error");
      return {};
    }
    if (toolName === "find_exact_symbol") {
      cb(null, envelope(JSON.stringify({ count: 1, matches: [{ id: "n1", name: "Example", kind: "function", file: "src/example.ts", line: 1 }] })), "");
      return {};
    }
    if (toolName === "body") {
      cb(null, envelope("No matching symbol body found."), "");
      return {};
    }
    cb(null, envelope("{}"), "");
    return {};
  });

  const result = await execute(pi, "tokensave_symbol", { name: "Example", includeCallers: true }, ctx);
  assert.match(result.content[0].text, /Callers lookup failed/);
});

// ---------------------------------------------------------------------------
// Individual response-shape fixtures required by the spec
// ---------------------------------------------------------------------------

test("tokensave_symbol renders callers and callees arrays", async () => {
  const { pi, ctx } = setup();
  mockCli({
    find_exact_symbol: () => ({ json: { count: 1, matches: [{ id: "n1", name: "Example", kind: "function", file: "src/example.ts", line: 1 }] } }),
    body: () => ({ text: "No matching symbol body found." }),
    callers: () => ({ json: [{ name: "caller_one", file: "src/a.ts", line: 3 }] }),
    callees: () => ({ json: [{ name: "callee_one", file: "src/b.ts", line: 9 }] }),
  });

  const result = await execute(pi, "tokensave_symbol", { name: "Example", includeCallers: true, includeCallees: true }, ctx);
  assert.match(result.content[0].text, /Callers \(1\)/);
  assert.match(result.content[0].text, /caller_one/);
  assert.match(result.content[0].text, /Callees \(1\)/);
  assert.match(result.content[0].text, /callee_one/);
});

test("tokensave_impact({ file }) renders diff-context object response", async () => {
  const { pi, ctx } = setup();
  mockCli({
    file_dependents: () => ({ json: { count: 0, dependents: [] } }),
    diff_context: () => ({
      json: {
        changed_files: ["src/example.ts"],
        modified_symbols: [{ name: "helper", kind: "function", file: "src/example.ts", line: 12 }],
        impacted_symbols_count: 1,
        impacted_symbols: [{ name: "caller", file: "src/caller.ts", line: 4 }],
        affected_tests: [],
      },
    }),
  });

  const result = await execute(pi, "tokensave_impact", { file: "src/example.ts" }, ctx);
  assert.match(result.content[0].text, /Directly modified symbols \(1\)/);
  assert.match(result.content[0].text, /helper/);
  assert.match(result.content[0].text, /Downstream impacted symbols \(1\)/);
  assert.match(result.content[0].text, /caller/);
});

// ---------------------------------------------------------------------------
// Oversized/truncated and malformed-but-non-throwing responses
// ---------------------------------------------------------------------------

test("tokensave_search handles an oversized/truncated response text without throwing", async () => {
  const { pi, ctx } = setup();
  setExecFileImplForTest((_file, args: string[], _options, cb: Cb) => {
    if (args[1] === "search") {
      // Runner represents an oversized non-JSON payload as truncated markdown text.
      cb(null, envelope("partial output that got cut off mid-w"), "");
      return {};
    }
    cb(null, envelope("{}"), "");
    return {};
  });

  const result = await execute(pi, "tokensave_search", { query: "big" }, ctx);
  assert.equal(typeof result.content[0].text, "string");
});

test("no registered tool throws when TokenSave returns an unexpected but valid plain-text response", async () => {
  const { pi, ctx } = setup();
  setExecFileImplForTest((_file, _args: string[], _options, cb: Cb) => {
    cb(null, envelope("Unexpected plain-text response from a future TokenSave version."), "");
    return {};
  });

  const invocations: Array<[string, unknown]> = [
    ["tokensave_status", {}],
    ["tokensave_context", { task: "x" }],
    ["tokensave_find_symbol", { name: "Example" }],
    ["tokensave_search", { query: "Example" }],
    ["tokensave_symbol", { name: "Example" }],
    ["tokensave_impact", { name: "Example" }],
  ];

  for (const [name, params] of invocations) {
    await assert.doesNotReject(async () => execute(pi, name, params, ctx), `tool '${name}' threw`);
  }
});

// ---------------------------------------------------------------------------
// file_dependents: official TokenSave v7.1.0 response shape (issue #1)
// ---------------------------------------------------------------------------

test("tokensave_impact({ file }) renders bare path dependents from the official v7.1.0 file_dependents shape", async () => {
  const { pi, ctx } = setup();
  mockCli({
    file_dependents: () => ({
      json: { file: "src/example.ts", count: 2, dependents: ["src/a.ts", "src/b.ts"] },
    }),
    diff_context: () => ({ json: { changed_files: ["src/example.ts"], modified_symbols: [], impacted_symbols_count: 0, impacted_symbols: [], affected_tests: [] } }),
  });

  const result = await execute(pi, "tokensave_impact", { file: "src/example.ts" }, ctx);
  assert.match(result.content[0].text, /src\/a\.ts/);
  assert.match(result.content[0].text, /src\/b\.ts/);
  assert.doesNotMatch(result.content[0].text, / \?(\n|$)/);
});

// ---------------------------------------------------------------------------
// tokensave_symbol: implementation lookup dispatch by symbol kind (issue #2)
// ---------------------------------------------------------------------------

test("tokensave_symbol dispatches to tokensave_implementations({ trait }) for an interface/trait symbol", async () => {
  const { pi, ctx } = setup();
  let implementationsArgs: unknown;
  mockCli({
    find_exact_symbol: () => ({ json: { count: 1, matches: [{ id: "n1", name: "Runner", kind: "interface", file: "src/runner.ts", line: 5 }] } }),
    body: () => ({ text: "No matching symbol body found." }),
    implementations: (args) => {
      implementationsArgs = args;
      return { json: { match_count: 1, implementations: [{ file: "src/impl_a.ts", signature: "class ImplA implements Runner" }] } };
    },
  });

  const result = await execute(pi, "tokensave_symbol", { name: "Runner", includeImplementations: true }, ctx);
  assert.deepEqual(implementationsArgs, { trait: "Runner", limit: 10 });
  assert.match(result.content[0].text, /ImplA/);
});

test("tokensave_symbol dispatches to tokensave_implementations({ method }) for a function/method symbol", async () => {
  const { pi, ctx } = setup();
  let implementationsArgs: unknown;
  mockCli({
    find_exact_symbol: () => ({ json: { count: 1, matches: [{ id: "n1", name: "run", kind: "function", file: "src/run.ts", line: 5 }] } }),
    body: () => ({ text: "No matching symbol body found." }),
    implementations: (args) => {
      implementationsArgs = args;
      return { json: { match_count: 1, implementations: [{ file: "src/other.ts", signature: "function run()" }] } };
    },
  });

  const result = await execute(pi, "tokensave_symbol", { name: "run", includeImplementations: true }, ctx);
  assert.deepEqual(implementationsArgs, { method: "run", limit: 10 });
  assert.match(result.content[0].text, /run\(\)/);
});

test("tokensave_symbol dispatches to tokensave_impls({ type }) for a class/struct symbol", async () => {
  const { pi, ctx } = setup();
  let implsArgs: unknown;
  mockCli({
    find_exact_symbol: () => ({ json: { count: 1, matches: [{ id: "n1", name: "Example", kind: "class", file: "src/example.ts", line: 5 }] } }),
    body: () => ({ text: "No matching symbol body found." }),
    impls: (args) => {
      implsArgs = args;
      return {
        json: {
          count: 1,
          truncated: false,
          impls: [{ type: "Example", trait: "Runner", file: "src/example.ts", start_line: 10, signature: "impl Runner for Example" }],
        },
      };
    },
  });

  const result = await execute(pi, "tokensave_symbol", { name: "Example", includeImplementations: true }, ctx);
  assert.deepEqual(implsArgs, { type: "Example", limit: 10 });
  assert.match(result.content[0].text, /impl Runner for Example/);
});

// ---------------------------------------------------------------------------
// tokensave_find_symbol: path filters apply to find_exact_symbol results too (issue #3)
// ---------------------------------------------------------------------------

test("tokensave_find_symbol({ pathInclude }) filters find_exact_symbol results locally, not only the fallback search", async () => {
  const { pi, ctx } = setup();
  mockCli({
    find_exact_symbol: () => ({
      json: {
        count: 2,
        matches: [
          { id: "a", name: "WellModel", kind: "class", file: "other/models.py", line: 1 },
          { id: "b", name: "WellModel", kind: "class", file: "core/models/well_model.py", line: 4 },
        ],
      },
    }),
  });

  const result = await execute(pi, "tokensave_find_symbol", { name: "WellModel", pathInclude: ["core/"] }, ctx);
  assert.match(result.content[0].text, /core\/models\/well_model\.py/);
  assert.doesNotMatch(result.content[0].text, /other\/models\.py/);
});

// ---------------------------------------------------------------------------
// tokensave_find_symbol: symbol-kind priority within equal textual rank (issue #4)
// ---------------------------------------------------------------------------

test("tokensave_find_symbol({ name, limit: 1 }) prefers the class definition over a same-named field", async () => {
  const { pi, ctx } = setup();
  mockCli({
    find_exact_symbol: () => ({
      json: {
        count: 2,
        matches: [
          { id: "field-1", name: "WellModel", kind: "field", file: "src/other_class.py", line: 9 },
          { id: "class-1", name: "WellModel", kind: "class", file: "core/models/well_model.py", line: 4 },
        ],
      },
    }),
  });

  const result = await execute(pi, "tokensave_find_symbol", { name: "WellModel", limit: 1 }, ctx);
  assert.match(result.content[0].text, /core\/models\/well_model\.py/);
  assert.doesNotMatch(result.content[0].text, /other_class\.py/);
});

// ---------------------------------------------------------------------------
// Non-throwing decoders on malformed entries (issue #5)
// ---------------------------------------------------------------------------

test("tokensave_find_symbol does not throw on a malformed empty-object match", async () => {
  const { pi, ctx } = setup();
  mockCli({
    find_exact_symbol: () => ({ json: { count: 1, matches: [{}] } }),
  });

  await assert.doesNotReject(async () => execute(pi, "tokensave_find_symbol", { name: "Example" }, ctx));
});

test("tokensave_impact({ file }) does not throw on null/number dependents entries", async () => {
  const { pi, ctx } = setup();
  mockCli({
    file_dependents: () => ({ json: { count: 2, dependents: [null, 123] } }),
    diff_context: () => ({ json: { changed_files: [], modified_symbols: [], impacted_symbols_count: 0, impacted_symbols: [], affected_tests: [] } }),
  });

  await assert.doesNotReject(async () => execute(pi, "tokensave_impact", { file: "src/example.ts" }, ctx));
});

// ---------------------------------------------------------------------------
// Official response-shape probes required by the spec
// ---------------------------------------------------------------------------

test("tokensave_symbol({ includeImplementations }) handles the official empty implementations envelope", async () => {
  const { pi, ctx } = setup();
  mockCli({
    find_exact_symbol: () => ({ json: { count: 1, matches: [{ id: "n1", name: "run", kind: "method", file: "src/run.ts", line: 1 }] } }),
    body: () => ({ text: "No matching symbol body found." }),
    implementations: () => ({ json: { match_count: 1, implementations: [] } }),
  });

  const result = await execute(pi, "tokensave_symbol", { name: "run", includeImplementations: true }, ctx);
  assert.match(result.content[0].text, /Implementations \(1\)/);
});

test("tokensave_symbol({ includeImplementations }) handles the official empty impls envelope", async () => {
  const { pi, ctx } = setup();
  mockCli({
    find_exact_symbol: () => ({ json: { count: 1, matches: [{ id: "n1", name: "Example", kind: "struct", file: "src/example.ts", line: 1 }] } }),
    body: () => ({ text: "No matching symbol body found." }),
    impls: () => ({ json: { count: 1, truncated: false, impls: [] } }),
  });

  const result = await execute(pi, "tokensave_symbol", { name: "Example", includeImplementations: true }, ctx);
  assert.match(result.content[0].text, /Implementations \(1\)/);
});

// ---------------------------------------------------------------------------
// Candidate pool: user limit applied only after ranking (issue #1)
// ---------------------------------------------------------------------------

test("tokensave_find_symbol({ limit: 1 }) returns the class even when a same-named field arrives first", async () => {
  const { pi, ctx } = setup();
  let requestedLimit: unknown;
  mockCli({
    find_exact_symbol: (args) => {
      requestedLimit = args.limit;
      return {
        json: {
          count: 2,
          matches: [
            { id: "field-1", name: "WellModel", kind: "field", file: "src/other.py", line: 9 },
            { id: "class-1", name: "WellModel", kind: "class", file: "core/models/well_model.py", line: 4 },
          ],
        },
      };
    },
  });

  const result = await execute(pi, "tokensave_find_symbol", { name: "WellModel", limit: 1 }, ctx);
  assert.match(result.content[0].text, /core\/models\/well_model\.py/);
  assert.doesNotMatch(result.content[0].text, /other\.py/);
  assert.ok(typeof requestedLimit === "number" && requestedLimit >= 100, `candidate pool should be >= 100, got ${requestedLimit}`);
});

// ---------------------------------------------------------------------------
// Search decoding safety: malformed entries dropped, never thrown (issue #3)
// ---------------------------------------------------------------------------

test("tokensave_search does not throw on a malformed empty-object array entry", async () => {
  const { pi, ctx } = setup();
  mockCli({ search: () => ({ json: [{}] }) });

  const result = await execute(pi, "tokensave_search", { query: "anything" }, ctx);
  assert.equal(result.details.ok, true);
  assert.equal(result.details.count, 0);
});

test("tokensave_find_symbol does not throw when the fallback search returns a malformed entry", async () => {
  const { pi, ctx } = setup();
  mockCli({
    find_exact_symbol: () => ({ json: { count: 0, matches: [] } }),
    search: () => ({ json: [{}, { name: "" }] }),
  });

  await assert.doesNotReject(async () => execute(pi, "tokensave_find_symbol", { name: "Missing" }, ctx));
});

// ---------------------------------------------------------------------------
// Body vs implementation lookup names, and real trait-impl entries (issues #4/#5)
// ---------------------------------------------------------------------------

test("tokensave_symbol uses the qualified name for body and the bare name for the trait implementations lookup", async () => {
  const { pi, ctx } = setup();
  let bodySymbol: unknown;
  let implementationsArgs: unknown;
  mockCli({
    find_exact_symbol: () => ({
      json: { count: 1, matches: [{ id: "n1", name: "Runner", qualified_name: "pkg.Runner", kind: "interface", file: "src/runner.py", line: 3 }] },
    }),
    body: (args) => {
      bodySymbol = args.symbol;
      return { text: "No matching symbol body found." };
    },
    implementations: (args) => {
      implementationsArgs = args;
      return {
        json: {
          match_count: 1,
          implementations: [
            {
              type: "ImplA",
              qualified_name: "pkg.ImplA",
              kind: "class",
              file: "src/impl_a.py",
              line: 10,
              trait: "pkg.Runner",
              methods: [{ name: "run", signature: "def run(self)", body: "..." }],
            },
          ],
        },
      };
    },
  });

  const result = await execute(pi, "tokensave_symbol", { name: "Runner", includeImplementations: true }, ctx);
  assert.equal(bodySymbol, "pkg.Runner");
  assert.deepEqual(implementationsArgs, { trait: "Runner", limit: 10 });
  assert.match(result.content[0].text, /- ImplA — src\/impl_a\.py:10/);
  assert.match(result.content[0].text, /implements pkg\.Runner/);
  assert.match(result.content[0].text, /methods: run/);
  assert.doesNotMatch(result.content[0].text, /- \? —/);
});

// ---------------------------------------------------------------------------
// Unsupported implementation kind (issue #6)
// ---------------------------------------------------------------------------

test("tokensave_symbol returns a compact unsupported-kind message instead of a bogus impls lookup for a field", async () => {
  const { pi, ctx } = setup();
  let implsCalled = false;
  mockCli({
    find_exact_symbol: () => ({ json: { count: 1, matches: [{ id: "n1", name: "count", kind: "field", file: "src/model.py", line: 2 }] } }),
    body: () => ({ text: "No matching symbol body found." }),
    impls: () => {
      implsCalled = true;
      return { json: { count: 0, impls: [] } };
    },
  });

  const result = await execute(pi, "tokensave_symbol", { name: "count", includeImplementations: true }, ctx);
  assert.equal(implsCalled, false);
  assert.match(result.content[0].text, /not supported for kind 'field'/);
});

// ---------------------------------------------------------------------------
// Qualified-name fallback in name resolution (issue #7)
// ---------------------------------------------------------------------------

test("tokensave_symbol falls back to by_qualified_name when exact bare-name lookup finds nothing", async () => {
  const { pi, ctx } = setup();
  let qualifiedArgs: unknown;
  mockCli({
    find_exact_symbol: () => ({ json: { count: 0, matches: [] } }),
    by_qualified_name: (args) => {
      qualifiedArgs = args;
      return { json: { count: 1, matches: [{ id: "n9", name: "Runner", qualified_name: "pkg.Runner", kind: "interface", file: "src/runner.py", line: 3 }] } };
    },
    body: () => ({ text: "No matching symbol body found." }),
  });

  const result = await execute(pi, "tokensave_symbol", { name: "pkg.Runner", includeBody: false }, ctx);
  assert.deepEqual(qualifiedArgs, { qualified_name: "pkg.Runner" });
  assert.match(result.content[0].text, /src\/runner\.py:3/);
});

// ---------------------------------------------------------------------------
// Official by_qualified_name direct-array shape (issue: array vs envelope)
// ---------------------------------------------------------------------------

/** The exact official TokenSave by_qualified_name response: a direct array. */
const OFFICIAL_QUALIFIED_ARRAY = [
  {
    node_id: "n9",
    name: "Runner",
    qualified_name: "pkg.Runner",
    kind: "interface",
    file: "src/runner.py",
    start_line: 3,
    end_line: 20,
  },
];

test("tokensave_find_symbol resolves the official by_qualified_name array shape without fallback search", async () => {
  const { pi, ctx } = setup();
  let searchCalled = false;
  mockCli({
    find_exact_symbol: () => ({ json: { count: 0, matches: [] } }),
    by_qualified_name: () => ({ json: OFFICIAL_QUALIFIED_ARRAY }),
    search: () => {
      searchCalled = true;
      return { json: [] };
    },
  });

  const result = await execute(pi, "tokensave_find_symbol", { name: "pkg.Runner" }, ctx);
  assert.equal(searchCalled, false, "fallback search must not be called");
  assert.match(result.content[0].text, /node id: n9/);
  assert.match(result.content[0].text, /file: src\/runner\.py:3/);
});

test("tokensave_symbol resolves the official by_qualified_name array shape without fallback search", async () => {
  const { pi, ctx } = setup();
  let searchCalled = false;
  mockCli({
    find_exact_symbol: () => ({ json: { count: 0, matches: [] } }),
    by_qualified_name: () => ({ json: OFFICIAL_QUALIFIED_ARRAY }),
    search: () => {
      searchCalled = true;
      return { json: [] };
    },
  });

  const result = await execute(pi, "tokensave_symbol", { name: "pkg.Runner", includeBody: false }, ctx);
  assert.equal(searchCalled, false, "fallback search must not be called");
  assert.match(result.content[0].text, /src\/runner\.py:3/);
});

test("tokensave_impact resolves the official by_qualified_name array shape without fallback search", async () => {
  const { pi, ctx } = setup();
  let searchCalled = false;
  let impactArgs: Record<string, unknown> | undefined;
  mockCli({
    find_exact_symbol: () => ({ json: { count: 0, matches: [] } }),
    by_qualified_name: () => ({ json: OFFICIAL_QUALIFIED_ARRAY }),
    search: () => {
      searchCalled = true;
      return { json: [] };
    },
    impact: (args) => {
      impactArgs = args;
      return { json: { node_count: 1, nodes: [{ name: "Runner", file: "src/runner.py", line: 3 }] } };
    },
  });

  const result = await execute(pi, "tokensave_impact", { name: "pkg.Runner" }, ctx);
  assert.equal(searchCalled, false, "fallback search must not be called");
  assert.equal(impactArgs?.node_id, "n9");
  assert.match(result.content[0].text, /src\/runner\.py:3/);
});

// ---------------------------------------------------------------------------
// Concrete-type impls formatting: no bare "- ?" when signature is null
// ---------------------------------------------------------------------------

test("tokensave_symbol formats a signature-less impls entry as 'type implements trait' rather than '- ?'", async () => {
  const { pi, ctx } = setup();
  mockCli({
    find_exact_symbol: () => ({ json: { count: 1, matches: [{ id: "n1", name: "Example", kind: "struct", file: "src/example.py", line: 5 }] } }),
    body: () => ({ text: "No matching symbol body found." }),
    impls: () => ({
      json: {
        count: 1,
        truncated: false,
        impls: [
          {
            impl_id: "impl-1",
            type: "Example",
            qualified_name: "pkg.Example",
            trait: "Runner",
            trait_qualified_name: "pkg.Runner",
            file: "src/example.py",
            start_line: 5,
            end_line: 20,
            signature: null,
          },
        ],
      },
    }),
  });

  const result = await execute(pi, "tokensave_symbol", { name: "Example", includeImplementations: true }, ctx);
  assert.doesNotMatch(result.content[0].text, /- \?/);
  assert.match(result.content[0].text, /Example implements Runner — src\/example\.py:5/);
});
