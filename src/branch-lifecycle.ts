import { runTokensaveCommand } from "./runner.ts";

const GIT_TIMEOUT_MS = 5_000;
/**
 * An incremental sync after weeks of drift takes about 15s on a large
 * repository. The ceiling only guards against a hung process: TokenSave
 * recovers the lock of a killed sync on its next run.
 */
const SYNC_TIMEOUT_MS = 120_000;
/** TokenSave refuses to start while another process (a git hook, another session) syncs. */
const SYNC_LOCK_PATTERN = /another sync is already in progress/i;

export interface BranchReconciliationResult {
	reconciled: boolean;
	warnings: string[];
}

interface GitExecutor {
	exec(
		command: string,
		args: string[],
		options: { cwd: string; timeout: number },
	): Promise<{ code: number | null; stdout: string }>;
}

export interface BranchIndexLifecycle {
	reset(): void;
	reconcile(
		pi: GitExecutor,
		projectRoot: string,
	): Promise<BranchReconciliationResult>;
}

/**
 * Reconciles TokenSave's indexes with local Git state, doing the work of
 * TokenSave's post-checkout and post-commit hooks. Those hooks never run in a
 * repository that overrides `core.hooksPath` (husky, for example).
 *
 * The fingerprint covers every local branch name and tip commit, so it changes
 * on branch creation, checkout, rename, deletion, and commit. An unchanged
 * fingerprint costs one `git branch` call and no TokenSave process.
 */
export function createBranchIndexLifecycle(): BranchIndexLifecycle {
	const fingerprints = new Map<string, string>();
	const inFlight = new Map<string, Promise<BranchReconciliationResult>>();

	async function reconcileOnce(
		pi: GitExecutor,
		projectRoot: string,
	): Promise<BranchReconciliationResult> {
		const refs = await pi.exec(
			"git",
			[
				"branch",
				"--no-color",
				"--format=%(HEAD)%09%(refname)%09%(objectname)",
				"--sort=refname",
			],
			{ cwd: projectRoot, timeout: GIT_TIMEOUT_MS },
		);
		if (refs.code !== 0) {
			return { reconciled: false, warnings: [] };
		}

		const fingerprint = refs.stdout.trim();
		if (!fingerprint || fingerprints.get(projectRoot) === fingerprint) {
			return { reconciled: false, warnings: [] };
		}

		// A detached HEAD (rebase, bisect) also prints a `*` line, but its refname
		// is `(HEAD detached at ...)`. It has no branch index to add or sync.
		const onBranch = fingerprint
			.split("\n")
			.some((line) => line.startsWith("*\trefs/heads/"));
		const warnings: string[] = [];
		let lockContended = false;

		async function runStep(args: string[], timeoutMs?: number): Promise<boolean> {
			const result = await runTokensaveCommand(args, projectRoot, timeoutMs);
			if (result.ok) return true;
			const label = `tokensave ${args[0]}${args[0] === "branch" ? ` ${args[1]}` : ""}`;
			const output = result.stderr || result.stdout;
			if (SYNC_LOCK_PATTERN.test(output)) {
				// Another process is already syncing: retry at the next tool call.
				lockContended = true;
			} else if (result.errorKind === "timeout") {
				warnings.push(`${label} timed out.`);
			} else {
				warnings.push(output || `${label} failed`);
			}
			return false;
		}

		// `branch add` is a no-op for a tracked branch, so `sync` refreshes the
		// checked-out branch index after a commit made outside TokenSave's hooks.
		if (onBranch && (await runStep(["branch", "add", "--path", projectRoot]))) {
			await runStep(["sync", projectRoot], SYNC_TIMEOUT_MS);
		}
		await runStep(["branch", "gc", "--path", projectRoot]);

		const reconciled = warnings.length === 0 && !lockContended;
		if (reconciled) {
			fingerprints.set(projectRoot, fingerprint);
		}
		return { reconciled, warnings };
	}

	return {
		reset() {
			fingerprints.clear();
			inFlight.clear();
		},
		async reconcile(pi, projectRoot) {
			const pending = inFlight.get(projectRoot);
			if (pending) return pending;

			const operation = reconcileOnce(pi, projectRoot);
			inFlight.set(projectRoot, operation);
			try {
				return await operation;
			} finally {
				if (inFlight.get(projectRoot) === operation) {
					inFlight.delete(projectRoot);
				}
			}
		},
	};
}
