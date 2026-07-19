import { createRequire } from 'node:module';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);

type BinField = string | Record<string, string> | undefined;

/**
 * Resolve the `better-ccusage` binary entry path.
 *
 * `better-ccusage` must be resolvable alongside this package: it is declared
 * as a runtime `dependency` in package.json, so in a published install it is a
 * sibling under `node_modules/better-ccusage`, and in the monorepo it resolves
 * through the pnpm workspace symlink. There is intentionally no fallback: a
 * previous hardcoded `../../better-ccusage/src/index.ts` path shipped to npm
 * and caused a silent `MODULE_NOT_FOUND` because `src/` is not published. Fail
 * loudly instead so misconfiguration is obvious.
 */
export function resolveBinaryPath(): string {
	const packageJsonPath = nodeRequire.resolve('better-ccusage/package.json');
	const packageJson = nodeRequire(packageJsonPath) as { bin?: BinField; publishConfig?: { bin?: BinField } };
	const binField: BinField = packageJson.bin ?? packageJson.publishConfig?.bin;
	const binRelative = typeof binField === 'string'
		? binField
		: (binField != null ? (binField['better-ccusage'] ?? Object.values(binField)[0]) : undefined);
	if (binRelative == null) {
		throw new Error(`better-ccusage package.json at ${packageJsonPath} has no resolvable bin field`);
	}
	return path.resolve(path.dirname(packageJsonPath), binRelative);
}
