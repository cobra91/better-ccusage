/**
 * @fileoverview pi-agent (and oh-my-pi) data adapter.
 *
 * Reads the JSONL session files that pi and its widely used fork oh-my-pi
 * (omp) write under `~/.pi/agent/sessions` and `~/.omp/agent/sessions`
 * respectively, and normalizes each assistant message that carries token
 * usage into the shared {@link UsageData} shape so the unified
 * better-ccusage loaders can aggregate it alongside the other sources.
 *
 * Both directories are auto-detected when neither `PI_AGENT_DIR` nor a custom
 * path is set (matches upstream ccusage PR ccusage/ccusage#1338). Entries are
 * deduplicated by the loader's `createUniqueHash`, so a session file present
 * in both directories is counted once.
 *
 * Cost handling: pi writes a per-message `cost.total` (USD). We emit it as
 * `costUSD` so the `auto` cost mode (the default) uses it directly; the
 * `calculate` mode still recomputes from tokens via the shared engine.
 *
 * Token handling is additive (the Claude model): the four buckets
 * (input/output/cache-read/cache-write) are independent and summed, with no
 * subtraction of cached tokens from input (unlike Codex). When
 * `totalTokens` exceeds the sum of the known buckets, the surplus is folded
 * into `output_tokens` (when output is 0) — matches upstream's
 * `apply_total_token_fallback`.
 *
 * Per the upstream omp PR, models are NOT prefixed (`[pi]`/`[omp]`): both
 * default directories share the same `pi` source label and the same pricing
 * lookup.
 *
 * @module pi-adapter
 */

import type { LoadOptions, UsageData } from './data-loader.ts';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createFixture } from 'fs-fixture';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import {
	DEFAULT_OMP_SESSIONS_PATH,
	DEFAULT_PI_SESSIONS_PATH,
	PI_AGENT_DIR_ENV,
	PI_SESSION_GLOB,
	USER_HOME_DIR,
} from './_consts.ts';
import {
	createISOTimestamp,
	createMessageId,
	createModelName,
	createRequestId,
	createSessionId,
	createSource,
	createVersion,
} from './_types.ts';
import { logger } from './logger.ts';

/**
 * First non-empty trimmed string in a list; `undefined` if none.
 */
function firstNonEmpty(values: Array<string | null | undefined>): string | undefined {
	for (const value of values) {
		if (value == null) {
			continue;
		}
		const trimmed = value.trim();
		if (trimmed !== '') {
			return trimmed;
		}
	}
	return undefined;
}

// --- pi JSONL valibot schemas --------------------------------------------

/**
 * A message's cost blob. pi writes `cost.total` (USD); the object form is
 * normalized, a non-object `cost` (e.g. `0`) yields `undefined`.
 */
const piCostSchema = v.optional(
	v.union([
		v.object({ total: v.optional(v.number()) }),
		v.unknown(),
	]),
);

const piUsageSchema = v.object({
	input: v.optional(v.number(), 0),
	output: v.optional(v.number(), 0),
	cacheRead: v.optional(v.number(), 0),
	cacheWrite: v.optional(v.number(), 0),
	totalTokens: v.optional(v.number(), 0),
	cost: piCostSchema,
});

const piMessageSchema = v.object({
	role: v.optional(v.string()),
	model: v.optional(v.string()),
	usage: v.optional(piUsageSchema),
});

const piLineSchema = v.object({
	type: v.optional(v.string()),
	timestamp: v.optional(v.string()),
	message: v.optional(piMessageSchema),
});

/**
 * Extract the display cost (USD) from a pi `cost` field. Accepts the object
 * form `{ total }`; anything else returns `undefined`.
 */
function extractCost(cost: unknown): number | undefined {
	if (cost == null || typeof cost !== 'object') {
		return undefined;
	}
	const total = (cost as Record<string, unknown>).total;
	return typeof total === 'number' ? total : undefined;
}

/**
 * Apply upstream's `apply_total_token_fallback`: if `totalTokens` exceeds the
 * sum of the known buckets, fold the missing tokens into `output` (when
 * output is 0), else drop them (they are accounted as an unpriced surplus).
 * Returns the possibly-adjusted token buckets.
 */
function applyTotalTokenFallback(usage: {
	input: number;
	output: number;
	cacheCreation: number;
	cacheRead: number;
}, totalTokens: number): { input: number; output: number; cacheCreation: number; cacheRead: number } {
	const known = usage.input + usage.output + usage.cacheCreation + usage.cacheRead;
	const missing = totalTokens > known ? totalTokens - known : 0;
	if (missing === 0) {
		return usage;
	}
	if (usage.output === 0) {
		return { ...usage, output: missing };
	}
	// Non-zero output: surplus tokens are an unpriced extra (upstream tracks
	// them as `extra_total_tokens`); we leave the billable buckets unchanged.
	return usage;
}

/**
 * Total tokens across the four buckets. Matches upstream's
 * `total_usage_tokens`. Used to skip zero-token messages.
 */
function totalUsageTokens(usage: {
	input: number;
	output: number;
	cacheCreation: number;
	cacheRead: number;
}): number {
	return usage.input + usage.output + usage.cacheCreation + usage.cacheRead;
}

// --- path resolution -----------------------------------------------------

/**
 * Get the pi/omp sessions directories to scan.
 *
 * Resolution order (mirrors upstream `pi/paths.rs` + PR #1338):
 * 1. `PI_AGENT_DIR` env var (comma-separated list of explicit dirs)
 * 2. Sentinel `['']` under VITEST (signals callers to skip the source)
 * 3. Default: scan both `~/.pi/agent/sessions` AND `~/.omp/agent/sessions`,
 *    keeping only those that exist on disk. Order is `.pi` then `.omp`.
 *
 * Unlike the single-path adapters (codex/devin), this returns an array
 * because omp auto-detection scans two directories.
 */
export function getPiPaths(): string[] {
	const envDir = process.env[PI_AGENT_DIR_ENV]?.trim();
	if (envDir != null && envDir !== '') {
		return envDir
			.split(',')
			.map(p => p.trim())
			.filter(p => p !== '')
			.map(p => path.resolve(p));
	}

	if (process.env.VITEST != null) {
		return [''];
	}

	const candidates = [
		path.join(USER_HOME_DIR, DEFAULT_PI_SESSIONS_PATH),
		path.join(USER_HOME_DIR, DEFAULT_OMP_SESSIONS_PATH),
	];
	return candidates.filter(p => existsSync(p));
}

// --- per-file parsing ----------------------------------------------------

/**
 * Extract the session id from a session file path. Matches upstream's
 * `extract_session_id`: split the filename stem on the first `_` and take
 * the part after (e.g. `agent_abc123.jsonl` -> `abc123`); if no `_`, use
 * the whole stem.
 */
function extractSessionId(filePath: string): string {
	const stem = path.basename(filePath, path.extname(filePath));
	const underscoreIndex = stem.indexOf('_');
	return underscoreIndex >= 0 ? stem.slice(underscoreIndex + 1) : stem;
}

/**
 * Extract the project label from a session file path. Matches upstream's
 * `extract_project`: the path component immediately after the first
 * `sessions` component; `"unknown"` if none.
 *
 * The path is normalized to the OS separator first because `tinyglobby`
 * returns forward-slash paths even on Windows.
 */
function extractProject(filePath: string): string {
	const parts = path.normalize(filePath).split(path.sep);
	const sessionsIndex = parts.indexOf('sessions');
	if (sessionsIndex >= 0 && sessionsIndex + 1 < parts.length) {
		const next = parts[sessionsIndex + 1];
		if (next !== undefined && next !== '') {
			return next;
		}
	}
	return 'unknown';
}

/**
 * Whether a parsed pi line should be accepted as a billable message.
 * Matches upstream's `is_pi_message_usage`: keep when `type` is absent or
 * `"message"`, AND `message.role === "assistant"`, AND `message.usage` is
 * present.
 */
function isBillableMessage(line: v.InferOutput<typeof piLineSchema>): boolean {
	if (line.type != null && line.type !== 'message') {
		return false;
	}
	if (line.message == null) {
		return false;
	}
	if (line.message.role !== 'assistant') {
		return false;
	}
	return line.message.usage != null;
}

// --- main entry point ----------------------------------------------------

/**
 * Read every JSONL session file under the given directories and transform
 * each billable assistant message into a {@link UsageData} entry.
 *
 * @param dirs - Absolute session directories to scan (typically the pi +
 * omp defaults, or a custom list from `PI_AGENT_DIR`)
 * @param _options - Load options (kept for parity with the other adapters)
 * @returns Transformed usage entries (one per billable assistant message)
 */
export async function processPiSessions(
	dirs: string[],
	_options: LoadOptions = {},
): Promise<UsageData[]> {
	const results: UsageData[] = [];
	for (const dir of dirs) {
		if (dir === '') {
			logger.debug('Pi sessions directory is empty, skipping');
			continue;
		}
		if (!existsSync(dir)) {
			logger.debug(`Pi sessions directory not found at ${dir}`);
			continue;
		}

		const files = await glob(PI_SESSION_GLOB, {
			cwd: dir,
			absolute: true,
		});

		for (const file of files) {
			let content: string;
			try {
				content = await readFile(file, 'utf-8');
			}
			catch (error) {
				logger.debug(`Failed to read pi session ${file}: ${String(error)}`);
				continue;
			}

			const sessionId = extractSessionId(file);
			const project = extractProject(file);

			const lines = content.split('\n');
			for (const line of lines) {
				// Cheap prefilter: skip lines lacking the substrings we need
				// before paying for a JSON parse (matches upstream's
				// `LinePrefilter::all(&[b'"usage"', b'"message"'])`).
				if (!line.includes('"usage"') || !line.includes('"message"')) {
					continue;
				}

				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				}
				catch {
					continue;
				}

				const lineResult = v.safeParse(piLineSchema, parsed);
				if (!lineResult.success) {
					continue;
				}
				const piLine = lineResult.output;
				if (!isBillableMessage(piLine)) {
					continue;
				}

				// Non-null asserted: isBillableMessage guarantees message + usage.
				const message = piLine.message!;
				const piUsage = message.usage!;

				// Resolve timestamp; skip if unparseable.
				const timestamp = piLine.timestamp?.trim();
				if (timestamp == null || timestamp === '') {
					continue;
				}
				const parsedMs = Date.parse(timestamp);
				if (Number.isNaN(parsedMs)) {
					continue;
				}
				const isoTimestamp = new Date(parsedMs).toISOString();

				const usage = applyTotalTokenFallback({
					input: piUsage.input,
					output: piUsage.output,
					cacheCreation: piUsage.cacheWrite,
					cacheRead: piUsage.cacheRead,
				}, piUsage.totalTokens);
				if (totalUsageTokens(usage) === 0) {
					continue;
				}

				// Model: not prefixed (matches upstream omp PR #1338 — both .pi
				// and .omp dirs share the `pi` source label and pricing lookup).
				const modelRaw = firstNonEmpty([message.model]);
				if (modelRaw === undefined) {
					// Without a model we cannot price; skip rather than guess.
					continue;
				}

				const costUSD = extractCost(piUsage.cost);
				// Stable message id: line index within the file is not tracked
				// here; dedup relies on the loader's createUniqueHash, which
				// keys on message+request id. We synthesize a per-line id from
				// the session id + timestamp + model + all four token buckets
				// (matching upstream's entry_id shape) so two messages in the
				// same session at the same instant with different buckets or
				// models stay distinct instead of being collapsed.
				const uniqueId = `${sessionId}#${isoTimestamp}#${modelRaw}#${usage.input}:${usage.output}:${usage.cacheRead}:${usage.cacheCreation}`;

				const entry: UsageData = {
					timestamp: createISOTimestamp(isoTimestamp),
					sessionId: createSessionId(sessionId),
					version: createVersion('1.0.0'),
					message: {
						usage: {
							input_tokens: usage.input,
							output_tokens: usage.output,
							cache_creation_input_tokens: usage.cacheCreation,
							cache_read_input_tokens: usage.cacheRead,
						},
						model: createModelName(modelRaw),
						id: createMessageId(uniqueId),
					},
					// Additive token model (Claude): cached tokens are a separate
					// bucket, not subtracted from input (unlike Codex).
					costUSD,
					requestId: createRequestId(uniqueId),
					// Virtual cwd root so pi sessions are distinguishable, keyed
					// by the project label derived from the path.
					cwd: path.join('pi', project),
					source: createSource('pi'),
				};
				results.push(entry);
			}
		}
	}

	logger.info(`Loaded ${results.length} pi usage entries from ${dirs.length} director${dirs.length === 1 ? 'y' : 'ies'}`);
	return results;
}

if (import.meta.vitest != null) {
	describe('processPiSessions', () => {
		it('parses assistant messages with usage into UsageData (additive)', async () => {
			await using fixture = await createFixture({
				'agent_abc123.jsonl': [
					JSON.stringify({
						type: 'message',
						timestamp: '2026-07-03T10:00:00Z',
						message: {
							role: 'assistant',
							model: 'gpt-5.4',
							usage: {
								input: 1000,
								output: 200,
								cacheRead: 500,
								cacheWrite: 50,
								totalTokens: 1750,
								cost: { total: 0.012 },
							},
						},
					}),
					// A user message: must be skipped.
					JSON.stringify({
						type: 'message',
						timestamp: '2026-07-03T10:05:00Z',
						message: { role: 'user', model: 'gpt-5.4', usage: { input: 10 } },
					}),
					// A tool/event line: must be skipped (type != message).
					JSON.stringify({
						type: 'tool_call',
						timestamp: '2026-07-03T10:10:00Z',
						message: { role: 'assistant', usage: { input: 5 } },
					}),
				].join('\n'),
			});

			const results = await processPiSessions([fixture.path]);
			expect(results).toHaveLength(1);
			const entry = results[0]!;
			expect(entry.source).toBe('pi');
			expect(entry.sessionId).toBe('abc123');
			expect(entry.message.model).toBe('gpt-5.4');
			// Additive: all four buckets kept, no subtraction.
			expect(entry.message.usage.input_tokens).toBe(1000);
			expect(entry.message.usage.output_tokens).toBe(200);
			expect(entry.message.usage.cache_creation_input_tokens).toBe(50);
			expect(entry.message.usage.cache_read_input_tokens).toBe(500);
			expect(entry.costUSD).toBeCloseTo(0.012);
		});

		it('applies totalTokens fallback: surplus goes to output when output is 0', async () => {
			await using fixture = await createFixture({
				'agent_tfb.jsonl': [
					JSON.stringify({
						type: 'message',
						timestamp: '2026-07-03T10:00:00Z',
						message: {
							role: 'assistant',
							model: 'm',
							// Known sum = 1000, total = 1500 -> 500 missing, output 0 -> fold in.
							usage: { input: 1000, output: 0, totalTokens: 1500 },
						},
					}),
				].join('\n'),
			});

			const results = await processPiSessions([fixture.path]);
			expect(results).toHaveLength(1);
			expect(results[0]!.message.usage.output_tokens).toBe(500);
			expect(results[0]!.message.usage.input_tokens).toBe(1000);
		});

		it('leaves non-zero output unchanged when totalTokens has a surplus', async () => {
			await using fixture = await createFixture({
				'agent_tfb2.jsonl': [
					JSON.stringify({
						type: 'message',
						timestamp: '2026-07-03T10:00:00Z',
						message: {
							role: 'assistant',
							model: 'm',
							// Known sum = 300, total = 1000 -> 700 surplus, output != 0 -> dropped.
							usage: { input: 200, output: 100, totalTokens: 1000 },
						},
					}),
				].join('\n'),
			});

			const results = await processPiSessions([fixture.path]);
			expect(results).toHaveLength(1);
			expect(results[0]!.message.usage.input_tokens).toBe(200);
			expect(results[0]!.message.usage.output_tokens).toBe(100);
		});

		it('handles non-object cost (e.g. cost: 0) without dropping the message', async () => {
			await using fixture = await createFixture({
				'agent_cost.jsonl': [
					JSON.stringify({
						type: 'message',
						timestamp: '2026-07-03T10:00:00Z',
						message: { role: 'assistant', model: 'm', usage: { input: 100, output: 50, cost: 0 } },
					}),
				].join('\n'),
			});

			const results = await processPiSessions([fixture.path]);
			expect(results).toHaveLength(1);
			expect(results[0]!.costUSD).toBeUndefined();
		});

		it('skips zero-token messages', async () => {
			await using fixture = await createFixture({
				'agent_zero.jsonl': [
					JSON.stringify({
						type: 'message',
						timestamp: '2026-07-03T10:00:00Z',
						message: { role: 'assistant', model: 'm', usage: { input: 0, output: 0 } },
					}),
					JSON.stringify({
						type: 'message',
						timestamp: '2026-07-03T10:05:00Z',
						message: { role: 'assistant', model: 'm', usage: { input: 10, output: 5 } },
					}),
				].join('\n'),
			});

			const results = await processPiSessions([fixture.path]);
			expect(results).toHaveLength(1);
			expect(results[0]!.message.usage.input_tokens).toBe(10);
		});

		it('skips messages without a model (cannot price, avoids mispricing)', async () => {
			await using fixture = await createFixture({
				'agent_nomodel.jsonl': [
					JSON.stringify({
						type: 'message',
						timestamp: '2026-07-03T10:00:00Z',
						message: { role: 'assistant', usage: { input: 50, output: 10 } },
					}),
				].join('\n'),
			});

			const results = await processPiSessions([fixture.path]);
			expect(results).toHaveLength(0);
		});

		it('deduplicates omp vs pi: same file content in both dirs yields one entry set', async () => {
			// Two separate fixture dirs with identical session content. The
			// adapter emits from both, but the loader's createUniqueHash would
			// collapse identical message+request ids. Here we verify the adapter
			// itself is stable (same id for same content) so the loader dedup
			// works: both entries share uniqueId -> collapsed downstream.
			const record = JSON.stringify({
				type: 'message',
				timestamp: '2026-07-03T10:00:00Z',
				message: { role: 'assistant', model: 'gpt-5.4', usage: { input: 100, output: 20 } },
			});
			await using fixture = await createFixture({
				pi: { 'agent_shared.jsonl': record },
				omp: { 'agent_shared.jsonl': record },
			});

			const results = await processPiSessions([`${fixture.path}/pi`, `${fixture.path}/omp`]);
			// Adapter returns 2 (one per dir); they share the same uniqueId so
			// the loader dedups them to 1 downstream.
			expect(results).toHaveLength(2);
			expect(results[0]!.message.id).toBe(results[1]!.message.id);
			expect(results[0]!.source).toBe('pi');
			expect(results[1]!.source).toBe('pi');
		});

		it('returns empty for the empty-path sentinel', async () => {
			const results = await processPiSessions(['']);
			expect(results).toEqual([]);
		});

		it('returns empty when the directory is missing', async () => {
			const results = await processPiSessions(['/nonexistent/pi/path']);
			expect(results).toEqual([]);
		});

		it('handles a malformed line without throwing', async () => {
			await using fixture = await createFixture({
				'agent_mixed.jsonl': [
					'{ not valid json',
					JSON.stringify({
						type: 'message',
						timestamp: '2026-07-03T10:00:00Z',
						message: { role: 'assistant', model: 'm', usage: { input: 1, output: 1 } },
					}),
				].join('\n'),
			});

			const results = await processPiSessions([fixture.path]);
			expect(results).toHaveLength(1);
		});

		it('extracts session id and project from nested paths', async () => {
			await using fixture = await createFixture({
				sessions: {
					myproject: {
						'agent_xyz.jsonl': JSON.stringify({
							type: 'message',
							timestamp: '2026-07-03T10:00:00Z',
							message: { role: 'assistant', model: 'm', usage: { input: 10, output: 5 } },
						}),
					},
				},
			});

			const results = await processPiSessions([fixture.path]);
			expect(results).toHaveLength(1);
			expect(results[0]!.sessionId).toBe('xyz');
			expect(results[0]!.cwd).toBe(path.join('pi', 'myproject'));
		});
	});

	describe('getPiPaths', () => {
		it('returns single-element empty array under VITEST when no env var is set', () => {
			const original = process.env.PI_AGENT_DIR;
			delete process.env.PI_AGENT_DIR;
			try {
				expect(getPiPaths()).toEqual(['']);
			}
			finally {
				if (original !== undefined) {
					process.env.PI_AGENT_DIR = original;
				}
			}
		});

		it('respects a single PI_AGENT_DIR', () => {
			const original = process.env.PI_AGENT_DIR;
			process.env.PI_AGENT_DIR = '/custom/pi';
			try {
				expect(getPiPaths()).toEqual([path.resolve('/custom/pi')]);
			}
			finally {
				if (original === undefined) {
					delete process.env.PI_AGENT_DIR;
				}
				else {
					process.env.PI_AGENT_DIR = original;
				}
			}
		});

		it('splits a comma-separated PI_AGENT_DIR into multiple resolved paths', () => {
			const original = process.env.PI_AGENT_DIR;
			process.env.PI_AGENT_DIR = '/custom/pi,/custom/omp';
			try {
				expect(getPiPaths()).toEqual([path.resolve('/custom/pi'), path.resolve('/custom/omp')]);
			}
			finally {
				if (original === undefined) {
					delete process.env.PI_AGENT_DIR;
				}
				else {
					process.env.PI_AGENT_DIR = original;
				}
			}
		});
	});

	describe('applyTotalTokenFallback', () => {
		it('returns usage unchanged when totalTokens <= known sum', () => {
			const u = { input: 100, output: 50, cacheCreation: 10, cacheRead: 5 };
			expect(applyTotalTokenFallback(u, 165)).toEqual(u);
			expect(applyTotalTokenFallback(u, 100)).toEqual(u);
		});
		it('folds surplus into output when output is 0', () => {
			const u = { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 };
			expect(applyTotalTokenFallback(u, 150).output).toBe(50);
		});
		it('leaves non-zero output unchanged on surplus', () => {
			const u = { input: 100, output: 30, cacheCreation: 0, cacheRead: 0 };
			expect(applyTotalTokenFallback(u, 200)).toEqual(u);
		});
	});
}
