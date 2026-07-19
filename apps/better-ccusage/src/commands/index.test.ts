import type { Args } from 'gunshi';
import process from 'node:process';
import { SOURCE_ORDER } from '../_consts.ts';

/**
 * Smoke tests for the CLI dispatch layer (commands/index.ts).
 *
 * The original motivation: `better-ccusage codex` threw a raw
 * `Command not found: codex` stack trace, and no test exercised the CLI entry
 * point — so the regression shipped. These tests cover the argv rewrite that
 * powers `better-ccusage <source> <report>` and the friendly unknown-command
 * error, which are the two pieces of logic gunshi does not provide and that
 * broke silently.
 *
 * We test `rewriteArgv` directly (a pure function) rather than driving the full
 * `run()` + gunshi path, because the latter would require mocking the pricing
 * fetcher, every adapter, and consola — all of which are already covered by
 * their own unit tests. A few `run()` tests mock gunshi's `cli` to assert the
 * rewritten argv reaches it.
 */

// vi.mock is hoisted before imports. We mock gunshi's `cli` so we can capture
// the argv it receives without actually running a report (which would hit the
// filesystem and pricing network). `vi` comes from vitest globals (see
// vitest.config.ts `globals: true`).
const cliMock = vi.fn<(args: string[], command: unknown, options?: { subCommands?: Map<string, unknown> }) => Promise<void>>();
vi.mock('gunshi', async (importOriginal) => {
	const actual = await importOriginal<typeof import('gunshi')>();
	return {
		...actual,
		cli: async (...args: Parameters<typeof actual.cli>) => cliMock(...args) as unknown as ReturnType<typeof actual.cli>,
	};
});

// Import AFTER the mock is registered so commands/index.ts picks up the mock.
const { run, rewriteArgv, subCommandUnion, UnknownCommandError } = await import('./index.ts');

const reportNames = subCommandUnion.map(([n]) => n);

describe('rewriteArgv', () => {
	describe('source-as-subcommand syntax', () => {
		for (const source of SOURCE_ORDER) {
			it(`rewrites '<source> daily' to 'daily --source <source>' for ${source}`, () => {
				const out = rewriteArgv([source, 'daily']);
				expect(out).toEqual(['daily', '--source', source]);
			});

			it(`rewrites '<source> <report> --flag' preserving flags for ${source}`, () => {
				const out = rewriteArgv([source, 'blocks', '--live', '--since', '20260101']);
				expect(out).toEqual(['blocks', '--live', '--since', '20260101', '--source', source]);
			});
		}

		it('defaults to daily when a source is given with no report', () => {
			expect(rewriteArgv(['codex'])).toEqual(['daily', '--source', 'codex']);
		});

		it('defaults to daily when a source is followed by flags but no report', () => {
			expect(rewriteArgv(['codex', '--json'])).toEqual(['daily', '--json', '--source', 'codex']);
		});

		it('treats a source followed by an unknown word as source + daily (not error)', () => {
			// 'codex foo' → codex is a source, 'foo' is not a report → shorthand
			// to 'codex daily' with 'foo' carried as a positional/rest.
			const out = rewriteArgv(['codex', 'foo']);
			expect(out).toEqual(['daily', 'foo', '--source', 'codex']);
		});
	});

	describe('plain report syntax (unchanged)', () => {
		for (const report of reportNames) {
			it(`leaves '<report>' untouched for ${report}`, () => {
				expect(rewriteArgv([report])).toEqual([report]);
			});

			it(`leaves '<report> --flags' untouched for ${report}`, () => {
				expect(rewriteArgv([report, '--json', '--breakdown'])).toEqual([report, '--json', '--breakdown']);
			});
		}
	});

	describe('flags-first / empty argv', () => {
		it('leaves a leading flag untouched', () => {
			expect(rewriteArgv(['--version'])).toEqual(['--version']);
		});

		it('leaves empty argv untouched', () => {
			expect(rewriteArgv([])).toEqual([]);
		});
	});

	describe('unknown commands', () => {
		it('throws UnknownCommandError for an unknown positional', () => {
			try {
				rewriteArgv(['foobar']);
				throw new Error('expected rewriteArgv to throw');
			}
			catch (error) {
				expect(error).toBeInstanceOf(UnknownCommandError);
				expect((error as InstanceType<typeof UnknownCommandError>).unknown).toBe('foobar');
				expect((error as Error).message).toMatch(/Unknown command or source: 'foobar'/);
				expect((error as Error).message).toMatch(/Commands: daily, monthly/);
				expect((error as Error).message).toMatch(/Sources:\s+claude, droid, zcode, codex, opencode, devin/);
			}
		});

		it('does NOT throw for an unknown positional when it could be a value', () => {
			// 'daily foobar' → daily is a report, foobar is a positional/rest,
			// not a subcommand selector → left untouched.
			expect(rewriteArgv(['daily', 'foobar'])).toEqual(['daily', 'foobar']);
		});
	});
});

describe('run (CLI dispatch)', () => {
	afterEach(() => {
		cliMock.mockReset();
		vi.restoreAllMocks();
	});

	it('rewrites "<source> <report>" before dispatching to gunshi', async () => {
		const originalArgv = process.argv;
		process.argv = ['node', 'better-ccusage', 'codex', 'daily', '--breakdown'];
		try {
			await run();
			expect(cliMock).toHaveBeenCalledTimes(1);
			const dispatchedArgs = cliMock.mock.calls[0]![0];
			expect(dispatchedArgs).toEqual(['daily', '--breakdown', '--source', 'codex']);
		}
		finally {
			process.argv = originalArgv;
		}
	});

	it('strips a duplicated binary name (npx edge case) before rewriting', async () => {
		const originalArgv = process.argv;
		process.argv = ['node', 'better-ccusage', 'better-ccusage', 'codex', 'monthly'];
		try {
			await run();
			expect(cliMock).toHaveBeenCalledTimes(1);
			expect(cliMock.mock.calls[0]![0]).toEqual(['monthly', '--source', 'codex']);
		}
		finally {
			process.argv = originalArgv;
		}
	});

	it('passes a plain report through to gunshi unmodified', async () => {
		const originalArgv = process.argv;
		process.argv = ['node', 'better-ccusage', 'daily', '--json'];
		try {
			await run();
			expect(cliMock).toHaveBeenCalledTimes(1);
			expect(cliMock.mock.calls[0]![0]).toEqual(['daily', '--json']);
		}
		finally {
			process.argv = originalArgv;
		}
	});

	it('exits non-zero with a friendly message (no stack trace) for an unknown command', async () => {
		const originalArgv = process.argv;
		const { logger } = await import('../logger.ts');
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
			throw new Error(`process.exit(${code ?? 0})`);
		});
		process.argv = ['node', 'better-ccusage', 'totallyBogus'];
		try {
			await expect(run()).rejects.toThrow(/process\.exit\(1\)/);
			// gunshi must NOT have been reached (we failed before dispatch).
			expect(cliMock).not.toHaveBeenCalled();
			expect(exitSpy).toHaveBeenCalledWith(1);
			// The friendly message is logged via logger.error.
			expect(errorSpy).toHaveBeenCalledTimes(1);
			const logged = String(errorSpy.mock.calls[0]![0]);
			expect(logged).toMatch(/Unknown command or source: 'totallyBogus'/);
			expect(logged).toMatch(/Commands: daily, monthly/);
			expect(logged).toMatch(/Sources:\s+claude, droid, zcode, codex, opencode, devin/);
			// No raw stack trace leaks to the user-facing message.
			expect(logged).not.toMatch(/at (async )?run/);
		}
		finally {
			process.argv = originalArgv;
		}
	});
});

// Silence the unused-import lint for Args (kept for type discoverability).
export type _Args = Args;
