import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRulesBlock, buildRulesBlock, installRulesBlock, removeRulesBlock, stripRulesBlock } from "../src/rules.ts";

function tmpFile(name = "AGENTS.md"): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-tokensave-rules-"));
  return join(dir, name);
}

test("installRulesBlock creates the file when missing", () => {
  const path = tmpFile();
  assert.equal(existsSync(path), false);

  const { changed } = installRulesBlock(path);
  assert.equal(changed, true);
  assert.ok(existsSync(path));
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("<!-- pi-tokensave:start -->"));
  assert.ok(content.includes("<!-- pi-tokensave:end -->"));
});

test("applyRulesBlock appends to existing content without touching it", () => {
  const original = "# My AGENTS.md\n\nSome existing instructions.\n";
  const { content, changed } = applyRulesBlock(original);
  assert.equal(changed, true);
  assert.ok(content.startsWith("# My AGENTS.md\n\nSome existing instructions."));
  assert.ok(content.includes("<!-- pi-tokensave:start -->"));
});

test("applyRulesBlock does not duplicate an existing up-to-date block", () => {
  const once = applyRulesBlock("Existing content\n").content;
  const twice = applyRulesBlock(once).content;
  assert.equal(once, twice);
  assert.equal(once.split("<!-- pi-tokensave:start -->").length - 1, 1);
});

test("applyRulesBlock updates an old block to the current version", () => {
  const oldBlock = "<!-- pi-tokensave:start -->\n<!-- pi-tokensave:version=0 -->\n\nOld content\n\n<!-- pi-tokensave:end -->";
  const original = `Before.\n\n${oldBlock}\n\nAfter.\n`;

  const { content, changed } = applyRulesBlock(original, "1");
  assert.equal(changed, true);
  assert.ok(content.includes("Before."));
  assert.ok(content.includes("After."));
  assert.ok(!content.includes("Old content"));
  assert.ok(content.includes(buildRulesBlock("1")));
});

test("stripRulesBlock removes only the managed block and preserves surrounding content", () => {
  const before = "Line before.\n";
  const after = "\nLine after.\n";
  const original = `${before}\n${buildRulesBlock()}\n${after}`;

  const { content, changed } = stripRulesBlock(original);
  assert.equal(changed, true);
  assert.ok(content.includes("Line before."));
  assert.ok(content.includes("Line after."));
  assert.ok(!content.includes("pi-tokensave:start"));
});

test("stripRulesBlock is a no-op when no block is present", () => {
  const original = "Just some content.\n";
  const { content, changed } = stripRulesBlock(original);
  assert.equal(changed, false);
  assert.equal(content, original);
});

test("removeRulesBlock on disk only strips the block", () => {
  const path = tmpFile();
  installRulesBlock(path);
  const before = readFileSync(path, "utf8");
  assert.ok(before.includes("pi-tokensave:start"));

  const { changed } = removeRulesBlock(path);
  assert.equal(changed, true);
  const after = readFileSync(path, "utf8");
  assert.ok(!after.includes("pi-tokensave:start"));
});

test("installRulesBlock on an empty file produces just the block with a trailing newline", () => {
  const path = tmpFile();
  installRulesBlock(path);
  const content = readFileSync(path, "utf8");
  assert.ok(content.endsWith("<!-- pi-tokensave:end -->\n"));
});

// ---------------------------------------------------------------------------
// Byte-for-byte preservation of content outside the managed block
// ---------------------------------------------------------------------------

function roundTrip(original: string): string {
  const installed = applyRulesBlock(original).content;
  return stripRulesBlock(installed).content;
}

test("preserves trailing spaces on the last line", () => {
  const original = "Some notes.   ";
  assert.equal(roundTrip(original), original);
});

test("preserves content with no terminal newline", () => {
  const original = "# AGENTS.md\n\nNo trailing newline here";
  assert.equal(roundTrip(original), original);
});

test("preserves multiple terminal newlines", () => {
  const original = "# AGENTS.md\n\nSome instructions.\n\n\n\n";
  assert.equal(roundTrip(original), original);
});

test("preserves multiple blank lines before and after unrelated sections", () => {
  const original = "Section A.\n\n\n\nSection B.\n\n\nSection C.\n";
  assert.equal(roundTrip(original), original);
});

test("preserves CRLF content", () => {
  const original = "# AGENTS.md\r\n\r\nSome CRLF instructions.\r\n";
  const installed = applyRulesBlock(original).content;
  assert.ok(installed.startsWith(original));
  assert.equal(stripRulesBlock(installed).content, original);
});

test("replaces an old block in the middle of the file without touching content before or after it", () => {
  const before = "Intro paragraph.\n";
  const after = "Trailing paragraph.\n";
  const oldBlock = "<!-- pi-tokensave:start -->\n<!-- pi-tokensave:version=0 -->\n\nOld content\n\n<!-- pi-tokensave:end -->";
  const original = `${before}\n${oldBlock}\n\n${after}`;

  const { content } = applyRulesBlock(original, "1");
  assert.ok(content.startsWith(`${before}\n`));
  assert.ok(content.endsWith(`\n\n${after}`));
  assert.ok(!content.includes("Old content"));
  assert.ok(content.includes(buildRulesBlock("1")));
});

test("removal restores the original content exactly for a freshly installed block", () => {
  const originals = [
    "",
    "Hello world",
    "Hello world.\n",
    "Hello world.\n\n\n\n",
    "Trailing spaces here.   ",
    "CRLF content.\r\n\r\n",
  ];
  for (const original of originals) {
    assert.equal(roundTrip(original), original, `round-trip mismatch for ${JSON.stringify(original)}`);
  }
});
