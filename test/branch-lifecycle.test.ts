import test from "node:test";
import assert from "node:assert/strict";
import { createBranchIndexLifecycle } from "../src/branch-lifecycle.ts";
import { setExecFileImplForTest } from "../src/runner.ts";

type Cb = (
	error: NodeJS.ErrnoException | null,
	stdout: string,
	stderr: string,
) => void;

function fakePi(getRefs: () => string) {
	return {
		async exec(command: string) {
			assert.equal(command, "git");
			return { code: 0, stdout: getRefs(), stderr: "", killed: false };
		},
	};
}

test.afterEach(() => setExecFileImplForTest(undefined));

test("reconciles creation, checkout, and deletion while skipping an unchanged branch set", async () => {
	let refs = "*\tmain\n \tfeature/old";
	const commands: string[][] = [];
	setExecFileImplForTest((_file, args: string[], _options, cb: Cb) => {
		commands.push(args);
		cb(null, "ok", "");
		return {};
	});

	const lifecycle = createBranchIndexLifecycle();
	const pi = fakePi(() => refs);

	await lifecycle.reconcile(pi, "/repo");
	assert.deepEqual(
		commands.map((args) => args.slice(0, 2)),
		[
			["branch", "add"],
			["branch", "gc"],
		],
	);

	await lifecycle.reconcile(pi, "/repo");
	assert.equal(
		commands.length,
		2,
		"unchanged refs should not invoke tokensave again",
	);

	refs = " \tmain\n*\tfeature/new\n \tfeature/old";
	await lifecycle.reconcile(pi, "/repo");
	assert.equal(
		commands.length,
		4,
		"creating and checking out a branch should reconcile",
	);

	refs = " \tmain\n*\tfeature/new";
	await lifecycle.reconcile(pi, "/repo");
	assert.equal(
		commands.length,
		6,
		"deleting a local branch should run branch gc",
	);
});

test("detached HEAD skips branch add but still removes stale indexes", async () => {
	const commands: string[][] = [];
	setExecFileImplForTest((_file, args: string[], _options, cb: Cb) => {
		commands.push(args);
		cb(null, "ok", "");
		return {};
	});

	const lifecycle = createBranchIndexLifecycle();
	await lifecycle.reconcile(
		fakePi(() => " \tmain"),
		"/repo",
	);

	assert.deepEqual(
		commands.map((args) => args.slice(0, 2)),
		[["branch", "gc"]],
	);
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
	const pi = fakePi(() => "*\tmain");
	await lifecycle.reconcile(pi, "/repo");
	await lifecycle.reconcile(pi, "/repo");

	assert.equal(calls, 4);
});
