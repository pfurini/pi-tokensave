/**
 * Optional smoke test against a real TokenSave install. Skips itself when
 * the `tokensave` binary is not on PATH, so the suite never depends on it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkTokensaveAvailable, runTokensaveCommand, runTokensaveTool } from "../src/runner.ts";
import { rankSymbolMatches } from "../src/tools.ts";

const execFileAsync = promisify(execFile);

test("real tokensave: init + find_exact_symbol locates WellModel", async (t) => {
  const available = await checkTokensaveAvailable();
  if (!available) {
    t.skip("tokensave binary not found on PATH; skipping smoke test");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "pi-tokensave-smoke-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "main.py"),
    [
      "class WellModel:",
      "    def __init__(self, name):",
      "        self.name = name",
      "",
      "def create_well(name):",
      "    return WellModel(name)",
      "",
    ].join("\n"),
  );

  const init = await runTokensaveCommand(["init", dir], dir, 30_000);
  assert.equal(init.ok, true, init.stderr);

  const result = await runTokensaveTool("find_exact_symbol", { name: "WellModel" }, { projectRoot: dir });
  assert.ok(result.ok, !result.ok ? result.message : "expected ok result");
  if (!result.ok) return;

  const data = result.data as { matches: Array<{ name: string; file: string }> };
  const ranked = rankSymbolMatches("WellModel", data.matches);
  assert.equal(ranked[0].name, "WellModel");
  assert.equal(ranked[0].file, "src/main.py");

  await execFileAsync("rm", ["-rf", dir]);
});
