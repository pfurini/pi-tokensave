import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProjectInitialized, resolveProjectRoot } from "../src/project.ts";

test("resolveProjectRoot finds .tokensave at the cwd itself", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tokensave-root-"));
  mkdirSync(join(root, ".tokensave"));
  assert.equal(resolveProjectRoot(root), root);
  rmSync(root, { recursive: true, force: true });
});

test("resolveProjectRoot walks up from a subdirectory to find .tokensave", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tokensave-root-"));
  mkdirSync(join(root, ".tokensave"));
  const subdir = join(root, "backend", "api");
  mkdirSync(subdir, { recursive: true });

  assert.equal(resolveProjectRoot(subdir), root);
  assert.ok(isProjectInitialized(resolveProjectRoot(subdir)));
  rmSync(root, { recursive: true, force: true });
});

test("resolveProjectRoot stops at a Git repository boundary when no .tokensave is found", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tokensave-root-"));
  mkdirSync(join(root, ".git"));
  const subdir = join(root, "src", "feature");
  mkdirSync(subdir, { recursive: true });

  assert.equal(resolveProjectRoot(subdir), root);
  assert.equal(isProjectInitialized(resolveProjectRoot(subdir)), false);
  rmSync(root, { recursive: true, force: true });
});

test("resolveProjectRoot falls back to cwd when nothing is found before the filesystem root boundary", () => {
  const isolated = mkdtempSync(join(tmpdir(), "pi-tokensave-isolated-"));
  const subdir = join(isolated, "a", "b", "c");
  mkdirSync(subdir, { recursive: true });

  // No .tokensave and no .git anywhere under `isolated`, so resolution should
  // not silently walk further than necessary; it returns the original cwd.
  assert.equal(resolveProjectRoot(subdir), subdir);
  rmSync(isolated, { recursive: true, force: true });
});
