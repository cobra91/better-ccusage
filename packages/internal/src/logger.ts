import type { ConsolaInstance } from 'consola';
import process from 'node:process';
import { consola } from 'consola';

/**
 * Create a named logger instance backed by consola.
 * Respects the `LOG_LEVEL` environment variable for verbosity control.
 *
 * @param name - Tag name for the logger (e.g., 'ccusage', 'mcp')
 * @returns Configured consola logger instance
 */
export function createLogger(name: string): ConsolaInstance {
	const logger: ConsolaInstance = consola.withTag(name);

	// Apply LOG_LEVEL environment variable if set
	if (process.env.LOG_LEVEL != null) {
		const level = Number.parseInt(process.env.LOG_LEVEL, 10);
		if (!Number.isNaN(level)) {
			logger.level = level;
		}
	}

	return logger;
}

/** Direct console.log reference for output that must bypass the logger */
// eslint-disable-next-line no-console
export const log = console.log;
