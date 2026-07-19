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
 */
export async function resolveBinaryPath(): Promise<string> {
	// Try the published workspace package first. We use Result.try per the
	// coding guidelines (prefer Result over try-catch); resolution failures
	// are expected on dev installs without the package hoisted.
	const resolveResult = Result.try({
		try: () => nodeRequire.resolve('better-ccusage/package.json'),
		catch: error => error,
	})();

	if (Result.isSuccess(resolveResult)) {
		const packageJsonPath = resolveResult.value;
		const packageJson = nodeRequire(packageJsonPath) as { bin?: BinField; publishConfig?: { bin?: BinField } };
		const binField: BinField = packageJson.bin ?? packageJson.publishConfig?.bin;
		const binRelative = typeof binField === 'string'
			? binField
			: (binField != null ? (binField['better-ccusage'] ?? Object.values(binField)[0]) : undefined);
		if (binRelative != null) {
			return path.resolve(path.dirname(packageJsonPath), binRelative);
		}
	}

	// Development fallback: monorepo sibling (apps/better-ccusage/src/index.ts).
	const currentDir = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(currentDir, '..', '..', 'better-ccusage', 'src', 'index.ts');
}
