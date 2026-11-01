import type { LoadOptions } from 'better-ccusage/data-loader';
import { getClaudePaths } from 'better-ccusage/data-loader';

/**
 * Create default loading options using the first available Claude data path.
 * When no Claude data exists the path is left empty: the child CLI then runs
 * its own default discovery, which degrades gracefully in multi-provider
 * setups instead of failing server startup.
 * @returns LoadOptions with the default claudePath resolved
 */
export function defaultOptions(): LoadOptions {
	let paths: string[];
	try {
		paths = getClaudePaths();
	}
	catch {
		paths = [];
	}
	return { claudePath: paths[0] ?? '' } as const satisfies LoadOptions;
}
