import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import spawn, { SubprocessError } from 'nano-spawn';

/**
 * Print a deprecation notice to stderr (so it never pollutes JSON output on
 * stdout). Suppressed when stdout is not a TTY or when the user sets
 * OPENCODE_NO_DEPRECATION_NOTICE to opt out (useful for CI noise reduction).
 */
function printDeprecationNotice(): void {
	// process.stdout.isTTY is `true` on a TTY, `undefined` (not `false`) when
	// redirected to a pipe/file. Use a truthiness check so the notice is
	// suppressed in both non-TTY cases.
	if (!process.stdout.isTTY) {
		return;
	}
	if (process.env.OPENCODE_NO_DEPRECATION_NOTICE === '1') {
		return;
	}
	process.stderr.write(
		'[@better-ccusage/opencode] This package is deprecated. OpenCode support is now built into better-ccusage.\n'
		+ '[@better-ccusage/opencode] Run `npx better-ccusage` directly. Forwarding your invocation now.\n'
		+ '[@better-ccusage/opencode] To silence this notice set OPENCODE_NO_DEPRECATION_NOTICE=1.\n',
	);
}

/**
 * Environment overrides that scope better-ccusage toward the OpenCode source.
 *
 * The standalone opencode tool historically read only OpenCode data. Under
 * the new unified model, better-ccusage aggregates every detected source by
 * default (matching upstream `ccusage` behavior). We silence Droid and ZCode
 * here so forwarded invocations lean toward OpenCode data, but Claude is
 * intentionally left enabled because `getClaudePaths()` throws when
 * CLAUDE_CONFIG_DIR points at an invalid path, and forcing a valid-but-empty
 * Claude dir is brittle.
 *
 * OPENCODE_DATA_DIR is inherited from the parent env (not overridden) so the
 * user's real OpenCode database is read.
 *
 * NOTE: for true opencode-only scoping in the future, add a `--source opencode`
 * flag to better-ccusage (planned). For now, callers who need strict
 * opencode-only output can filter the `source` field in the JSON output.
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
	if (process.env.CODEX_HOME == null || process.env.CODEX_HOME === '') {
		env.CODEX_HOME = path.join(os.tmpdir(), `nonexistent-codex-${process.pid}`);
	}
	return env;
}

/**
 * Spawn `better-ccusage` with the forwarded args, inheriting stdio so the
 * output (including `--json`) flows through unchanged. The process exits with
 * the child's exit code.
 *
 * `OPENCODE_DATA_DIR` is inherited from the parent env automatically, so
 * better-ccusage picks up OpenCode data from the same location the standalone
 * tool would have.
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
