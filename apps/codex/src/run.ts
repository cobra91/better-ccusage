import process from 'node:process';
import { runForwarder } from './forwarder.ts';
import { resolveBinaryPath } from './resolve-better-ccusage.ts';

/**
 * Entry point for the deprecated `@better-ccusage/codex` package.
 *
 * Codex support is now built into `better-ccusage` as the `codex` source. This
 * shim forwards every invocation to `better-ccusage` while preserving the
 * original `CODEX_HOME` env var, so existing aliases and CI scripts keep
 * working unchanged. A one-line deprecation notice is printed to stderr.
 */
export async function run(): Promise<void> {
	// When invoked through npx, the binary name may be passed as the first
	// argument; filter it out so it doesn't confuse gunshi downstream.
	const args = process.argv.slice(2).filter(arg => arg !== 'better-ccusage-codex');

	const betterCcusageBin = resolveBinaryPath();
	await runForwarder(betterCcusageBin, args);
}
