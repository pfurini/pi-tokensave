import test from "node:test";
import assert from "node:assert/strict";
import {
  checkTokensaveAvailability,
  runTokensaveCommand,
  runTokensaveTool,
  setExecFileImplForTest,
} from "../src/runner.ts";

type Cb = (error: (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null, stdout: string, stderr: string) => void;

function envelope(text: string): string {
  return JSON.stringify({ content: [{ type: "text", text }] });
}

test.afterEach(() => {
  setExecFileImplForTest(undefined);
});

test("builds argv as an array with tool/name/--project/--args/--json, no shell", async () => {
  let capturedFile: string | undefined;
  let capturedArgs: string[] | undefined;
  let capturedOptions: Record<string, unknown> | undefined;

  setExecFileImplForTest((file, args, options, cb: Cb) => {
    capturedFile = file;
    capturedArgs = args;
    capturedOptions = options as unknown as Record<string, unknown>;
    cb(null, envelope('{"ok":true}'), "");
    return {};
  });

  const result = await runTokensaveTool("status", { foo: "bar" }, { projectRoot: "/tmp/proj" });

  assert.equal(capturedFile, "tokensave");
  assert.deepEqual(capturedArgs, ["tool", "status", "--project", "/tmp/proj", "--args", '{"foo":"bar"}', "--json"]);
  assert.equal((capturedOptions as any).shell, undefined);
  assert.ok(result.ok);
});

test("parses JSON content payload", async () => {
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    cb(null, envelope(JSON.stringify({ hello: "world" })), "");
    return {};
  });

  const result = await runTokensaveTool("status", {}, { projectRoot: "/tmp" });
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.data, { hello: "world" });
    assert.equal(result.isMarkdown, false);
  }
});

test("treats non-JSON content as markdown text", async () => {
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    cb(null, envelope("## Code Context\nsome markdown"), "");
    return {};
  });

  const result = await runTokensaveTool("context", { task: "x" }, { projectRoot: "/tmp" });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.isMarkdown, true);
    assert.equal(result.data, "## Code Context\nsome markdown");
  }
});

test("classifies binary-not-found errors", async () => {
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    const err = new Error("spawn tokensave ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    cb(err, "", "");
    return {};
  });

  const result = await runTokensaveTool("status", {}, { projectRoot: "/tmp" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "binary_not_found");
});

test("classifies timeout errors", async () => {
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    const err = new Error("timeout") as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    err.killed = true;
    err.signal = "SIGTERM";
    cb(err, "", "");
    return {};
  });

  const result = await runTokensaveTool("status", {}, { projectRoot: "/tmp", timeoutMs: 10 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "timeout");
});

test("classifies cancellation via AbortSignal", async () => {
  const controller = new AbortController();
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    controller.abort();
    const err = new Error("aborted");
    err.name = "AbortError";
    cb(err as NodeJS.ErrnoException, "", "");
    return {};
  });

  const result = await runTokensaveTool("status", {}, { projectRoot: "/tmp", signal: controller.signal });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "cancelled");
});

test("classifies project-not-initialized failures from stderr text", async () => {
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    const err = new Error("exit 1") as NodeJS.ErrnoException;
    cb(err, "", "Error: config error: no TokenSave index found at '/tmp' — run 'tokensave init' first");
    return {};
  });

  const result = await runTokensaveTool("status", {}, { projectRoot: "/tmp" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "project_not_initialized");
});

test("classifies generic non-zero exit as command_failed", async () => {
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    const err = new Error("exit 1") as NodeJS.ErrnoException;
    cb(err, "", "Error: config error: unknown tool: 'nope'");
    return {};
  });

  const result = await runTokensaveTool("nope", {}, { projectRoot: "/tmp" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "command_failed");
});

test("classifies empty stdout as empty_result", async () => {
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    cb(null, "", "");
    return {};
  });

  const result = await runTokensaveTool("search", { query: "x" }, { projectRoot: "/tmp" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "empty_result");
});

test("classifies malformed JSON envelope", async () => {
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    cb(null, "{not json", "");
    return {};
  });

  const result = await runTokensaveTool("search", { query: "x" }, { projectRoot: "/tmp" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "malformed_json");
});

test("truncates oversized array output with an explicit note, never silently", async () => {
  const items = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `symbol_${i}`, blob: "x".repeat(50) }));
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    cb(null, envelope(JSON.stringify(items)), "");
    return {};
  });

  const result = await runTokensaveTool("search", { query: "x" }, { projectRoot: "/tmp", maxOutputChars: 2000 });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.truncated, true);
    assert.ok(result.truncationNote && result.truncationNote.length > 0);
    assert.ok(Array.isArray(result.data));
    assert.ok((result.data as unknown[]).length < items.length);
  }
});

// ---------------------------------------------------------------------------
// checkTokensaveAvailability
// ---------------------------------------------------------------------------

test("checkTokensaveAvailability reports available on a clean 'tokensave --version' exit", async () => {
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    cb(null, "tokensave 7.0.0", "");
    return {};
  });

  const result = await checkTokensaveAvailability();
  assert.deepEqual(result, { available: true });
});

test("checkTokensaveAvailability reports not_found on ENOENT", async () => {
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    const err = new Error("not found") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    cb(err, "", "");
    return {};
  });

  const result = await checkTokensaveAvailability();
  assert.equal(result.available, false);
  assert.equal(result.reason, "not_found");
});

test("checkTokensaveAvailability reports timeout when the process is killed by the timeout", async () => {
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    const err = new Error("timeout") as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    err.killed = true;
    err.signal = "SIGTERM";
    cb(err, "", "");
    return {};
  });

  const result = await checkTokensaveAvailability(10);
  assert.equal(result.available, false);
  assert.equal(result.reason, "timeout");
});

test("checkTokensaveAvailability reports permission_denied on EACCES", async () => {
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    const err = new Error("denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    cb(err, "", "");
    return {};
  });

  const result = await checkTokensaveAvailability();
  assert.equal(result.available, false);
  assert.equal(result.reason, "permission_denied");
});

test("checkTokensaveAvailability reports failed on a non-zero exit that is not a recognized error", async () => {
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    const err = new Error("exit 1") as NodeJS.ErrnoException;
    cb(err, "", "garbled crash output");
    return {};
  });

  const result = await checkTokensaveAvailability();
  assert.equal(result.available, false);
  assert.equal(result.reason, "failed");
});

test("checkTokensaveAvailability never treats a crash or non-zero exit as available (regression for the old !error-code-ENOENT check)", async () => {
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    const err = new Error("boom") as NodeJS.ErrnoException;
    err.code = "EPERM";
    cb(err, "", "");
    return {};
  });

  const result = await checkTokensaveAvailability();
  assert.equal(result.available, false);
});

// ---------------------------------------------------------------------------
// runTokensaveCommand output bounding
// ---------------------------------------------------------------------------

test("runTokensaveCommand bounds stdout/stderr with an explicit truncation message", async () => {
  const bigOutput = "x".repeat(20_000);
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    cb(null, bigOutput, "");
    return {};
  });

  const result = await runTokensaveCommand(["doctor"], "/tmp", 5000, 500);
  assert.equal(result.ok, true);
  assert.ok(result.stdout.length < bigOutput.length);
  assert.ok(/truncated/i.test(result.stdout));
});

test("runTokensaveCommand does not truncate output within the bound", async () => {
  setExecFileImplForTest((_file, _args, _options, cb: Cb) => {
    cb(null, "short output", "");
    return {};
  });

  const result = await runTokensaveCommand(["status"], "/tmp");
  assert.equal(result.stdout, "short output");
  assert.ok(!/truncated/i.test(result.stdout));
});
