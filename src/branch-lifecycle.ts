import { runTokensaveCommand } from "./runner.ts";

const GIT_TIMEOUT_MS = 5_000;

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
 * Reconciles TokenSave's tracked indexes with local Git branches.
 *
 * A stable fingerprint avoids invoking TokenSave before every tool call while
 * still detecting branch creation, checkout, rename, and deletion.
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
				"--format=%(HEAD)%09%(refname:short)",
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

		const hasCurrentBranch = fingerprint
			.split("\n")
			.some((line) => line.startsWith("*\t"));
		const warnings: string[] = [];

		if (hasCurrentBranch) {
			const add = await runTokensaveCommand(
				["branch", "add", "--path", projectRoot],
				projectRoot,
			);
			if (!add.ok)
				warnings.push(
					add.stderr || add.stdout || "tokensave branch add failed",
				);
		}

		const gc = await runTokensaveCommand(
			["branch", "gc", "--path", projectRoot],
			projectRoot,
		);
		if (!gc.ok)
			warnings.push(gc.stderr || gc.stdout || "tokensave branch gc failed");

		if (warnings.length === 0) {
			fingerprints.set(projectRoot, fingerprint);
		}
		return { reconciled: warnings.length === 0, warnings };
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
