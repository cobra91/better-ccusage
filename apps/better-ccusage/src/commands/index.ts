import process from 'node:process';
import { cli } from 'gunshi';
import packageJson from '../../package.json' with { type: 'json' };
import { SOURCE_ORDER } from '../_consts.ts';
import { logger } from '../logger.ts';
import { blocksCommand } from './blocks.ts';
import { dailyCommand } from './daily.ts';
import { monthlyCommand } from './monthly.ts';
import { sessionCommand } from './session.ts';
import { statuslineCommand } from './statusline.ts';
import { weeklyCommand } from './weekly.ts';

const { description, name, version } = packageJson;

// Re-export all commands for easy importing
export { blocksCommand, dailyCommand, monthlyCommand, sessionCommand, statuslineCommand, weeklyCommand };

/**
 * Command entries as tuple array
 */
export const subCommandUnion = [
	['daily', dailyCommand],
	['monthly', monthlyCommand],
	['weekly', weeklyCommand],
	['session', sessionCommand],
	['blocks', blocksCommand],
	['statusline', statuslineCommand],
] as const;

/**
 * Available command names extracted from union
 */
export type CommandName = typeof subCommandUnion[number][0];

/**
 * Set of valid report subcommand names, for fast membership checks.
 */
const reportNames = new Set<string>(subCommandUnion.map(([n]) => n));

/**
 * Set of valid data-source names (claude, droid, zcode, codex, opencode, devin),
 * for the `better-ccusage <source> <report>` positional syntax.
 */
const sourceNames = new Set<string>(SOURCE_ORDER);

/**
 * Map of available CLI subcommands
 */
const subCommands = new Map();
for (const [name, command] of subCommandUnion) {
	subCommands.set(name, command);
}

/**
 * Default command when no subcommand is specified (defaults to daily)
 */
const mainCommand = dailyCommand;

/**
 * Error thrown when the first positional argv token is neither a registered
 * report subcommand nor a known data source. {@link run} catches it, prints
 * a friendly message (no stack trace), and exits non-zero. Kept as a typed
 * error class so tests can distinguish it from gunshi's raw
 * `Command not found:` throw.
 */
export class UnknownCommandError extends Error {
	readonly unknown: string;

	constructor(unknown: string) {
		super(
			`Unknown command or source: '${unknown}'\n`
			+ `\nCommands: ${[...reportNames].join(', ')}`
			+ `\nSources:  ${[...sourceNames].join(', ')} (use as: ${name} <source> <command>, e.g. ${name} codex daily)`,
		);
		this.name = 'UnknownCommandError';
		this.unknown = unknown;
	}
}

/**
 * Build (and throw) the friendly "unknown command" error.
 *
 * gunshi 0.26 throws a raw `Command not found: <name>` with a stack trace when
 * the first positional is neither a registered subcommand nor omitted. We
 * intercept that here so users get a helpful list of valid commands and
 * sources instead of a stack trace. Throwing (rather than calling process.exit
 * directly) makes the path unit-testable.
 */
function failUnknownCommand(unknown: string): never {
	throw new UnknownCommandError(unknown);
}

/**
 * Rewrite the argv for the positional `<source> <report>` syntax into the
 * canonical `<report> --source <source>` form, so gunshi dispatches to the
 * report command with the source filter plumbed through.
 *
 * Example: `['codex', 'daily', '--breakdown']` → `['daily', '--breakdown', '--source', 'codex']`.
 *
 * Returns the (possibly rewritten) argv. When the first token is a source name
 * but the second is not a report (e.g. `better-ccusage codex` alone), the
 * function injects the default `daily` report so `better-ccusage codex` is a
 * shorthand for `better-ccusage codex daily`. Throws an {@link UnknownCommandError}
 * for a first positional that is neither a report nor a source.
 *
 * Exported for unit testing (the CLI dispatch itself is hard to exercise
 * without mocking the pricing fetcher and every adapter).
 */
export function rewriteArgv(args: string[]): string[] {
	const first = args[0];
	if (first == null || first.startsWith('-')) {
		return args;
	}

	// `<source> <report> [...flags]` → `<report> [...flags] --source <source>`
	if (sourceNames.has(first)) {
		const [, second, ...rest] = args;
		const report = second != null && reportNames.has(second) ? second : 'daily';
		const flags = second != null && reportNames.has(second) ? rest : args.slice(1);
		return [report, ...flags, '--source', first];
	}

	// Unknown positional that is not a report and not a source → friendly error.
	if (!reportNames.has(first)) {
		failUnknownCommand(first);
	}

	return args;
}

/**
 * Entry point for the CLI. Parses process arguments and delegates to Gunshi's
 * CLI runner with the configured subcommands.
 */
export async function run(): Promise<void> {
	// When invoked through npx, the binary name might be passed as the first argument
	// Filter it out if it matches the expected binary name
	let args = process.argv.slice(2);
	if (args[0] === 'better-ccusage') {
		args = args.slice(1);
	}

	try {
		// rewriteArgv may throw UnknownCommandError for an unknown first
		// positional; keep it inside the try so the catch turns it into the
		// friendly logger.error + non-zero exit instead of a raw throw.
		args = rewriteArgv(args);

		await cli(args, mainCommand, {
			name,
			version,
			description,
			subCommands,
			renderHeader: null,
		});
	}
	catch (error) {
		// Friendly handling for unknown commands: either our UnknownCommandError
		// (thrown by rewriteArgv, re-thrown here if it escaped) or gunshi's raw
		// `Command not found: <name>` safety net. In both cases, print the
		// helpful message and exit non-zero instead of showing a stack trace.
		if (error instanceof UnknownCommandError) {
			logger.error(error.message);
			process.exit(1);
		}
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith('Command not found:')) {
			const unknown = message.slice('Command not found:'.length).trim();
			const display = unknown !== '' ? unknown : '<empty>';
			logger.error(
				`Unknown command or source: '${display}'\n`
				+ `\nCommands: ${[...reportNames].join(', ')}`
				+ `\nSources:  ${[...sourceNames].join(', ')} (use as: ${name} <source> <command>, e.g. ${name} codex daily)`,
			);
			process.exit(1);
		}
		throw error;
	}
}
