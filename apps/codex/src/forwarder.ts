import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import spawn, { SubprocessError } from 'nano-spawn';

/**
 * Environment overrides that scope better-ccusage toward the Codex source.
 *
 * The standalone codex tool historically read only Codex logs. Under the new
 * unified model, better-ccusage aggregates every detected source by default
 * (matching upstream `ccusage` behavior). We silence Droid and ZCode here so
 * forwarded invocations lean toward Codex data, but Claude is intentionally
 * left enabled because `getClaudePaths()` throws when CLAUDE_CONFIG_DIR points
 * at an invalid path, and forcing a valid-but-empty Claude dir is brittle.
 *
 * CODEX_HOME is inherited from the parent env (not overridden) so the user's
 * real Codex sessions are read.
 *
 * NOTE: for true codex-only scoping in the future, add a `--source codex` flag
 * to better-ccusage (planned). For now, callers who need strict codex-only
 * output can filter the `source` field in the JSON output.
 */
function buildIsolatedEnv(): Record<string, string> {
	const env: Record<string, string> = {
		OFFLINE: 'true',
	};
	if (process.env.DROID_SESSIONS_DIR == null || process.env.DROID_SESSIONS_DIR === '') {
		env.DROID_SESSIONS_DIR = os.devNull;
	}
	if (process.env.ZCODE_HOME == null || process.env.ZCODE_HOME === '') {
		env.ZCODE_HOME = path.join(os.tmpdir(), `nonexistent-zcode-${process.pid}`);
	}
	return env;
}

/**
 * Print a deprecation notice to stderr (so it never pollutes JSON output on
 * stdout). Suppressed when stdout is not a TTY or when the user sets
 * CODEX_NO_DEPRECATION_NOTICE to opt out (useful for CI noise reduction).
 */
function printDeprecationNotice(): void {
	if (process.stdout.isTTY === false) {
		return;
	}
	if (process.env.CODEX_NO_DEPRECATION_NOTICE === '1') {
		return;
	}
	process.stderr.write(
		'[@better-ccusage/codex] This package is deprecated. Codex support is now built into better-ccusage.\n'
		+ '[@better-ccusage/codex] Run `npx better-ccusage` directly. Forwarding your invocation now.\n'
		+ '[@better-ccusage/codex] To silence this notice set CODEX_NO_DEPRECATION_NOTICE=1.\n',
	);
}

/**
 * Spawn `better-ccusage` with the forwarded args, inheriting stdio so the
 * output (including `--json`) flows through unchanged. The process exits with
 * the child's exit code.
 *
 * `CODEX_HOME` is inherited from the parent env automatically, so better-ccusage
 * picks up Codex logs from the same location the standalone tool would have.
 */
export async function runForwarder(binPath: string, args: string[]): Promise<void> {
	printDeprecationNotice();

	try {
		await spawn(process.execPath, [binPath, ...args], {
			stdio: 'inherit',
			env: buildIsolatedEnv(),
		});
	}
	catch (error) {
		if (error instanceof SubprocessError) {
			// Surface any stderr the child produced, then mirror its exit code.
			const message = (error.stderr ?? error.stdout ?? '').trim();
			if (message !== '') {
				process.stderr.write(`${message}\n`);
			}
			if (error.exitCode != null) {
				process.exit(error.exitCode);
			}
			process.exit(1);
		}
		throw error;
	}
}
