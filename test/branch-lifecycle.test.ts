import test from "node:test";
import assert from "node:assert/strict";
import { createBranchIndexLifecycle } from "../src/branch-lifecycle.ts";
import { setExecFileImplForTest } from "../src/runner.ts";

type Cb = (
	error: (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null,
	stdout: string,
	stderr: string,
) => void;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/** One `git branch --format=%(HEAD)%09%(refname)%09%(objectname)` line. */
function ref(name: string, sha = SHA_A, current = false): string {
	return `${current ? "*" : " "}\trefs/heads/${name}\t${sha}`;
}

function fakePi(getRefs: () => string) {
	return {
		async exec(command: string) {
			assert.equal(command, "git");
			return { code: 0, stdout: getRefs(), stderr: "", killed: false };
		},
	};
}

function recordCommands(): string[][] {
	const commands: string[][] = [];
	setExecFileImplForTest((_file, args: string[], _options, cb: Cb) => {
		commands.push(args);
		cb(null, "ok", "");
		return {};
	});
	return commands;
}

/** First word(s) of each TokenSave invocation: ["branch", "add"], ["sync"], ... */
function steps(commands: string[][]): string[] {
	return commands.map((args) => (args[0] === "branch" ? `branch ${args[1]}` : args[0]));
}

test.afterEach(() => setExecFileImplForTest(undefined));

test("reconciles creation, checkout, and deletion while skipping an unchanged branch set", async () => {
	let refs = [ref("feature/old"), ref("main", SHA_A, true)].join("\n");
	const commands = recordCommands();

	const lifecycle = createBranchIndexLifecycle();
	const pi = fakePi(() => refs);

	await lifecycle.reconcile(pi, "/repo");
	assert.deepEqual(steps(commands), ["branch add", "sync", "branch gc"]);

	await lifecycle.reconcile(pi, "/repo");
	assert.equal(
		commands.length,
		3,
		"unchanged refs should not invoke tokensave again",
	);

	refs = [ref("feature/new", SHA_A, true), ref("feature/old"), ref("main")].join("\n");
	await lifecycle.reconcile(pi, "/repo");
	assert.equal(
		commands.length,
		6,
		"creating and checking out a branch should reconcile",
	);

	refs = [ref("feature/new", SHA_A, true), ref("main")].join("\n");
	await lifecycle.reconcile(pi, "/repo");
	assert.equal(
		commands.length,
		9,
		"deleting a local branch should run branch gc",
	);
});

test("a commit on the checked-out branch syncs its index", async () => {
	let refs = ref("main", SHA_A, true);
	const commands = recordCommands();

	const lifecycle = createBranchIndexLifecycle();
	const pi = fakePi(() => refs);
	await lifecycle.reconcile(pi, "/repo");
	commands.length = 0;

	refs = ref("main", SHA_B, true);
	await lifecycle.reconcile(pi, "/repo");
	assert.deepEqual(steps(commands), ["branch add", "sync", "branch gc"]);
	assert.deepEqual(commands[1], ["sync", "/repo"]);
});

test("sync runs with a longer timeout than the branch commands", async () => {
	const timeouts: Record<string, number> = {};
	setExecFileImplForTest((_file, args: string[], options, cb: Cb) => {
		timeouts[args[0] === "branch" ? `branch ${args[1]}` : args[0]] = options.timeout;
		cb(null, "ok", "");
		return {};
	});

	await createBranchIndexLifecycle().reconcile(fakePi(() => ref("main", SHA_A, true)), "/repo");

	assert.ok(timeouts.sync > timeouts["branch add"]);
	assert.ok(timeouts.sync >= 120_000);
});

test("detached HEAD skips branch add and sync but still removes stale indexes", async () => {
	const commands = recordCommands();

	// Real `git branch` output during a rebase or bisect.
	const refs = [`*\t(HEAD detached at ${SHA_A.slice(0, 7)})\t${SHA_A}`, ref("main")].join("\n");
	await createBranchIndexLifecycle().reconcile(fakePi(() => refs), "/repo");

	assert.deepEqual(steps(commands), ["branch gc"]);
});

test("a failed branch add skips the sync and reports the failure", async () => {
	const commands: string[][] = [];
	setExecFileImplForTest((_file, args: string[], _options, cb: Cb) => {
		commands.push(args);
		if (args[1] === "add") {
			const error = new Error("failed") as NodeJS.ErrnoException;
			cb(error, "", "add failed");
		} else {
			cb(null, "ok", "");
		}
		return {};
	});

	const result = await createBranchIndexLifecycle().reconcile(fakePi(() => ref("main", SHA_A, true)), "/repo");

	assert.deepEqual(steps(commands), ["branch add", "branch gc"]);
	assert.equal(result.reconciled, false);
	assert.deepEqual(result.warnings, ["add failed"]);
});

test("failed reconciliation is retried instead of caching the branch fingerprint", async () => {
	let calls = 0;
	setExecFileImplForTest((_file, _args: string[], _options, cb: Cb) => {
		calls += 1;
		const error = new Error("failed") as NodeJS.ErrnoException;
		error.code = "EFAIL";
		cb(error, "", "failed");
		return {};
	});

	const lifecycle = createBranchIndexLifecycle();
	const pi = fakePi(() => ref("main", SHA_A, true));
	await lifecycle.reconcile(pi, "/repo");
	await lifecycle.reconcile(pi, "/repo");

	// branch add fails, so each attempt runs add and gc without sync.
	assert.equal(calls, 4);
});

test("a sync held by another process is retried later without a warning", async () => {
	let locked = true;
	const commands: string[][] = [];
	setExecFileImplForTest((_file, args: string[], _options, cb: Cb) => {
		commands.push(args);
		if (args[0] === "sync" && locked) {
			const error = new Error("exit 1") as NodeJS.ErrnoException;
			cb(error, "", "Error: sync lock: another sync is already in progress (PID 4242). If this is stale, remove /repo/.tokensave/sync.lock");
		} else {
			cb(null, "ok", "");
		}
		return {};
	});

	const lifecycle = createBranchIndexLifecycle();
	const pi = fakePi(() => ref("main", SHA_A, true));

	const contended = await lifecycle.reconcile(pi, "/repo");
	assert.equal(contended.reconciled, false);
	assert.deepEqual(contended.warnings, []);

	locked = false;
	commands.length = 0;
	const retried = await lifecycle.reconcile(pi, "/repo");
	assert.equal(retried.reconciled, true);
	assert.deepEqual(steps(commands), ["branch add", "sync", "branch gc"]);
});

test("a sync timeout is reported as a warning", async () => {
	setExecFileImplForTest((_file, args: string[], _options, cb: Cb) => {
		if (args[0] === "sync") {
			const error = new Error("timed out") as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
			error.killed = true;
			error.signal = "SIGTERM";
			cb(error, "partial progress", "");
		} else {
			cb(null, "ok", "");
		}
		return {};
	});

	const result = await createBranchIndexLifecycle().reconcile(fakePi(() => ref("main", SHA_A, true)), "/repo");

	assert.equal(result.reconciled, false);
	assert.deepEqual(result.warnings, ["tokensave sync timed out."]);
});
