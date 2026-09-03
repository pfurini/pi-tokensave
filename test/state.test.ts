import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPersistedConfig, savePersistedMode } from "../src/state.ts";

function parseJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		assert.fail(`Failed to parse ${path}: ${String(error)}`);
	}
}

test("branch lifecycle management is opt-in", () => {
	const path = join(
		mkdtempSync(join(tmpdir(), "pi-tokensave-state-")),
		"missing.json",
	);
	assert.deepEqual(loadPersistedConfig(path), {
		mode: "enforce",
		autoManageBranches: false,
	});
});

test("loads autoManageBranches and preserves it when changing mode", () => {
	const path = join(
		mkdtempSync(join(tmpdir(), "pi-tokensave-state-")),
		"config.json",
	);
	writeFileSync(
		path,
		JSON.stringify({ autoManageBranches: true, futureSetting: "keep" }),
		"utf8",
	);

	assert.deepEqual(loadPersistedConfig(path), {
		mode: "enforce",
		autoManageBranches: true,
	});

	savePersistedMode("prefer", path);
	assert.deepEqual(parseJsonFile(path), {
		autoManageBranches: true,
		futureSetting: "keep",
		mode: "prefer",
	});
});
