import type { LoadOptions } from 'better-ccusage/data-loader';
import { getClaudePaths } from 'better-ccusage/data-loader';

/**
 * Create default loading options using the first available Claude data path.
 * @returns LoadOptions with the default claudePath resolved
 * @throws Error if no valid Claude path is found
 */
export function defaultOptions(): LoadOptions {
	const paths = getClaudePaths();
	if (paths.length === 0) {
		throw new Error('No valid Claude path found. Ensure getClaudePaths() returns at least one valid path.');
	}
	return { claudePath: paths[0] } as const satisfies LoadOptions;
}
