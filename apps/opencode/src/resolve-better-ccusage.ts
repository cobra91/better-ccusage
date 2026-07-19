import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Result } from '@praha/byethrow';

const nodeRequire = createRequire(import.meta.url);

type BinField = string | Record<string, string> | undefined;

/**
 * Resolve the `better-ccusage` binary entry path.
 *
 * In a published install, `better-ccusage` is expected to be resolvable
 * alongside this package (e.g. installed as a sibling workspace dep). Falls
 * back to the monorepo sibling source during development so the shim works
 * without a published build.
 *
 * The whole resolution block (resolve + read package.json + read bin field)
 * is wrapped in a single `Result.try` so that ANY failure — missing package,
 * corrupt package.json, missing/malformed bin field — falls back to the dev
 * path rather than crashing the forwarder. This preserves the original
 * try-catch safety net while following the coding guideline to prefer Result.
 */
export async function resolveBinaryPath(): Promise<string> {
	const resolved = Result.try({
		try: (): string => {
			const packageJsonPath = nodeRequire.resolve('better-ccusage/package.json');
			const packageJson = nodeRequire(packageJsonPath) as { bin?: BinField; publishConfig?: { bin?: BinField } };
			const binField: BinField = packageJson.bin ?? packageJson.publishConfig?.bin;
			const binRelative = typeof binField === 'string'
				? binField
				: (binField != null ? (binField['better-ccusage'] ?? Object.values(binField)[0]) : undefined);
			if (binRelative == null) {
				throw new Error('better-ccusage package.json has no resolvable bin field');
			}
			return path.resolve(path.dirname(packageJsonPath), binRelative);
		},
		catch: error => error,
	})();

	if (Result.isSuccess(resolved)) {
		return resolved.value;
	}

	// Development fallback: monorepo sibling (apps/better-ccusage/src/index.ts).
	const currentDir = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(currentDir, '..', '..', 'better-ccusage', 'src', 'index.ts');
}
