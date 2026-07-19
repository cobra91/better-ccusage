/**
 * @fileoverview OpenCode data adapter.
 *
 * Reads the OpenCode SQLite database (opencode.db) where modern OpenCode
 * stores its messages and sessions, and normalizes each assistant message
 * that carries token usage into the shared {@link UsageData} shape so the
 * unified better-ccusage loaders can aggregate it alongside Claude/Droid/
 * ZCode/Codex data.
 *
 * Cost handling: OpenCode writes a pre-calculated `cost` (USD) on each
 * message. We emit it as `costUSD` so the `auto` cost mode (the default)
 * uses it directly without any pricing lookup; `calculate` mode still
 * recomputes from tokens via the shared engine.
 *
 * @module opencode-adapter
 */

import type { LoadOptions, UsageData } from './data-loader.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createFixture } from 'fs-fixture';
import * as v from 'valibot';
import {
	DEFAULT_OPENCODE_DB_SUBPATH,
	DEFAULT_OPENCODE_HOME_PATH,
	OPENCODE_DATA_DIR_ENV,
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
 * Normalized cache bucket, regardless of how OpenCode serialized it.
 */
type CacheBucket = { read: number; write: number };

/**
 * Map provider-specific model aliases to canonical names the shared pricing
 * fetcher recognizes. Ported from the standalone @better-ccusage/opencode
 * package's cost-utils.ts, but only kept when the target actually exists in
 * the pricing dataset (a previous `gemini-2.5-pro -> gemini-2.5-pro-preview`
 * alias was a no-op that mapped a priced name to an unpriced one).
 */
const OPENCODE_MODEL_ALIASES = new Map<string, string>([
	['gemini-3-pro-high', 'gemini-3-pro-preview'],
]);

/**
 * Resolve a model name to one the shared pricing fetcher can price.
 */
function resolveModelName(model: string): string {
	return OPENCODE_MODEL_ALIASES.get(model) ?? model;
}

/**
 * Coerce a SQLite value (BigInt for INTEGER columns) or null/non-finite to a
 * safe number. Mirrors the ZCode adapter helper.
 */
function toFiniteNumber(value: number | bigint | null | undefined): number {
	if (value == null) {
		return 0;
	}
	if (typeof value === 'bigint') {
		return Number(value);
	}
	return Number.isFinite(value) ? value : 0;
}

/**
 * A message's tokens blob. `input` already excludes cached tokens (verified:
 * input + output + reasoning + cache.read == total), so the Claude additive
 * cost model applies directly — no subtraction needed (unlike Codex).
 *
 * `cache` is typed loosely (`unknown`) because OpenCode sometimes writes
 * `cache: 0` instead of an object; we normalize it in {@link extractCache}.
 */
const tokensSchema = v.object({
	input: v.optional(v.number(), 0),
	output: v.optional(v.number(), 0),
	reasoning: v.optional(v.number(), 0),
	total: v.optional(v.number(), 0),
	cache: v.optional(v.unknown(), null),
});

const messageDataSchema = v.object({
	role: v.optional(v.string()),
	tokens: v.optional(tokensSchema),
	cost: v.optional(v.number()),
	modelID: v.optional(v.string()),
	providerID: v.optional(v.string()),
});

/**
 * Normalize the `cache` field into a {read, write} bucket. OpenCode writes
 * either `{ read, write }`, `0`, or `null`; any non-object form zeroes both
 * buckets so the message is kept rather than dropped.
 */
function extractCache(cache: unknown): CacheBucket {
	if (cache == null || typeof cache !== 'object') {
		return { read: 0, write: 0 };
	}
	const obj = cache as Record<string, unknown>;
	return {
		read: typeof obj.read === 'number' ? obj.read : 0,
		write: typeof obj.write === 'number' ? obj.write : 0,
	};
}

/**
 * Get the OpenCode database path.
 *
 * Resolution order:
 * 1. `OPENCODE_DATA_DIR` env var (resolved against cwd, then db subpath)
 * 2. Sentinel `''` under VITEST (signals callers to skip the source)
 * 3. Default `~/.local/share/opencode/opencode.db`
 *
 * Returns the default path even when it does not exist on disk; callers
 * handle missing files gracefully.
 */
export function getOpenCodeDbPath(): string {
	const envDir = process.env[OPENCODE_DATA_DIR_ENV]?.trim();
	if (envDir != null && envDir !== '') {
		return path.resolve(envDir, DEFAULT_OPENCODE_DB_SUBPATH);
	}

	if (process.env.VITEST != null) {
		return '';
	}

	return path.join(USER_HOME_DIR, DEFAULT_OPENCODE_HOME_PATH, DEFAULT_OPENCODE_DB_SUBPATH);
}

type MessageRow = {
	id: string;
	session_id: string;
	time_created: number | bigint;
	data: string;
	directory: string | null;
};

const MESSAGES_SQL = `
	SELECT m.id, m.session_id, m.time_created, m.data, s.directory
	FROM message AS m
	LEFT JOIN session AS s ON s.id = m.session_id
	ORDER BY m.time_created ASC
`;

/**
 * Read every assistant message that carries token usage from the OpenCode
 * SQLite database and transform each into a {@link UsageData} entry.
 *
 * The database is opened **read-only** so it never contends with a running
 * OpenCode process writing to the same file (SQLite handles concurrent WAL
 * readers natively). Cost is emitted from the message's pre-calculated
 * `cost` field so the `auto` cost mode uses it directly; `calculate` mode
 * recomputes from tokens via the shared engine.
 *
 * @param dbPath - Absolute path to the OpenCode SQLite database
 * @param _options - Load options (kept for parity with the other adapters)
 * @returns Transformed usage entries (one per assistant message with tokens)
 */
export async function processOpenCodeSessions(
	dbPath: string,
	_options: LoadOptions = {},
): Promise<UsageData[]> {
	if (dbPath === '') {
		logger.debug('OpenCode database path is empty, skipping');
		return [];
	}

	if (!existsSync(dbPath)) {
		logger.debug(`OpenCode database not found at ${dbPath}`);
		return [];
	}

	// Lazy-import node:sqlite so the module loads on runtimes that lack it
	// (e.g. Bun, used by the schema generator) and on Node < 22.13. Only the
	// actual OpenCode code path triggers the import.
	let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
	try {
		({ DatabaseSync } = await import('node:sqlite'));
	}
	catch (error) {
		logger.warn(`node:sqlite is not available on this runtime; OpenCode usage disabled. ${String(error)}`);
		return [];
	}

	let db: InstanceType<typeof DatabaseSync>;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
	}
	catch (error) {
		logger.warn(`Failed to open OpenCode database at ${dbPath}: ${String(error)}`);
		return [];
	}

	let rows: MessageRow[];
	try {
		const statement = db.prepare(MESSAGES_SQL);
		rows = statement.all() as MessageRow[];
	}
	catch (error) {
		logger.warn(`Failed to query OpenCode message table: ${String(error)}`);
		db[Symbol.dispose]();
		return [];
	}

	db[Symbol.dispose]();

	const results: UsageData[] = [];
	for (const row of rows) {
		// Parse the JSON data blob defensively.
		let parsedData: unknown;
		try {
			parsedData = JSON.parse(row.data);
		}
		catch (error) {
			logger.debug(`Failed to parse OpenCode message data for ${row.id}: ${String(error)}`);
			continue;
		}

		const dataResult = v.safeParse(messageDataSchema, parsedData);
		if (!dataResult.success) {
			continue;
		}
		const data = dataResult.output;

		// Skip messages without token usage (e.g. user messages, tool calls).
		if (data.tokens == null) {
			continue;
		}

		const tokens = data.tokens;
		// Skip all-zero entries (heartbeats, empty turns). Include reasoning in
		// the check so reasoning-only rows are not dropped (matches upstream
		// ccusage's non-zero check).
		if (tokens.input === 0 && tokens.output === 0 && tokens.total === 0 && tokens.reasoning === 0) {
			continue;
		}

		const cache = extractCache(tokens.cache);
		// Skip messages without a model id: without it we cannot price the
		// entry correctly, and guessing (e.g. defaulting to a specific paid
		// model) would silently misprice. Matches the ZCode adapter behavior.
		const modelRaw = (data.modelID ?? '').trim();
		if (modelRaw === '') {
			continue;
		}
		const timestamp = new Date(toFiniteNumber(row.time_created)).toISOString();
		const sessionId = row.session_id ?? 'unknown-session';
		// Stable message id: the message row id is already unique per message.
		const messageId = row.id ?? `${sessionId}#${timestamp}`;

		// Virtual cwd root so OpenCode sessions are distinguishable from
		// Claude/Droid/ZCode/Codex project paths, while keeping the real
		// directory visible when available.
		const cwd = row.directory != null && row.directory !== ''
			? path.join('opencode', row.directory)
			: path.join('opencode', 'unknown');

		// `tokens.input` already excludes cached tokens (verified on real data:
		// input + output + reasoning + cache.read == total across 130 messages),
		// so the Claude additive cost model applies directly — no subtraction
		// needed (unlike Codex, where input includes the cached portion).
		//
		// `tokens.reasoning` is a SEPARATE bucket in OpenCode (not included in
		// output, unlike Codex). We fold it into `output_tokens` so that:
		//   - reported token totals account for reasoning (not silently short)
		//   - in `calculate` mode, the reasoning cost is billed at the output
		//     rate rather than dropped
		// This matches upstream ccusage's `cost_usage` which adds
		// `extra_total_tokens` (the reasoning surplus) to `output_tokens` for
		// both costing and reporting (see adapter/opencode/parser.rs:126-130).
		const entry: UsageData = {
			timestamp: createISOTimestamp(timestamp),
			sessionId: createSessionId(sessionId),
			version: createVersion('1.0.0'),
			message: {
				usage: {
					input_tokens: tokens.input,
					output_tokens: tokens.output + tokens.reasoning,
					cache_creation_input_tokens: cache.write,
					cache_read_input_tokens: cache.read,
				},
				model: createModelName(resolveModelName(modelRaw)),
				id: createMessageId(messageId),
			},
			// OpenCode pre-calculates cost per message. Emit it so the `auto`
			// cost mode (the default) uses it directly; `calculate` mode
			// recomputes from tokens via the shared engine.
			costUSD: data.cost,
			requestId: createRequestId(messageId),
			cwd,
			source: createSource('opencode'),
		};

		results.push(entry);
	}

	logger.info(`Loaded ${results.length} OpenCode usage entries from ${dbPath}`);
	return results;
}

if (import.meta.vitest != null) {
	// Hoist the sqlite import once for all tests (CLAUDE.md discourages
	// repeated `await import()` in test bodies; the runtime-detection
	// justification from the production code does not apply under vitest).
	const { DatabaseSync } = await import('node:sqlite');

	describe('processOpenCodeSessions', () => {
		it('parses messages with tokens into UsageData (additive, no cache subtraction)', async () => {
			// Build a tiny in-memory SQLite DB matching the OpenCode schema.
			await using fixture = await createFixture({});
			const dbPath = `${fixture.path}/opencode.db`;
			const db = new DatabaseSync(dbPath);
			db.exec(`
				CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
				CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
			`);
			const insertMessage = db.prepare(
				'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
			);
			const insertSession = db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)');
			insertSession.run('ses_1', '/home/user/projects/app');
			insertMessage.run(
				'msg_1',
				'ses_1',
				1777388092686,
				1777388092686,
				JSON.stringify({
					role: 'assistant',
					tokens: { total: 17092, input: 15101, output: 30, reasoning: 41, cache: { write: 0, read: 1920 } },
					cost: 0.02655066,
					modelID: 'deepseek-v4-pro',
					providerID: 'opencode-go',
				}),
			);
			// A user message without tokens — must be skipped.
			insertMessage.run(
				'msg_2',
				'ses_1',
				1777388092700,
				1777388092700,
				JSON.stringify({ role: 'user', tokens: undefined, modelID: 'deepseek-v4-pro' }),
			);
			db[Symbol.dispose]();

			const results = await processOpenCodeSessions(dbPath);

			expect(results).toHaveLength(1);
			const entry = results[0]!;
			expect(entry.source).toBe('opencode');
			expect(entry.message.model).toBe('deepseek-v4-pro');
			// Additive model: input is the raw value (no cache subtraction).
			// Reasoning tokens (41) are folded into output_tokens (30 + 41 = 71).
			expect(entry.message.usage.input_tokens).toBe(15101);
			expect(entry.message.usage.output_tokens).toBe(71);
			expect(entry.message.usage.cache_creation_input_tokens).toBe(0);
			expect(entry.message.usage.cache_read_input_tokens).toBe(1920);
			// Pre-calculated cost emitted as costUSD.
			expect(entry.costUSD).toBeCloseTo(0.02655066);
			// Virtual cwd root uses path.join (OS-native separator).
			expect(entry.cwd).toBe(path.join('opencode', '/home/user/projects/app'));
		});

		it('resolves gemini-3-pro-high alias to gemini-3-pro-preview', async () => {
			await using fixture = await createFixture({});
			const dbPath = `${fixture.path}/opencode.db`;
			const db = new DatabaseSync(dbPath);
			db.exec(`CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE session (id TEXT, directory TEXT);`);
			db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
				'msg_x',
				'ses_x',
				1777388092686,
				1777388092686,
				JSON.stringify({ tokens: { input: 100, output: 50 }, modelID: 'gemini-3-pro-high' }),
			);
			db[Symbol.dispose]();

			const results = await processOpenCodeSessions(dbPath);
			expect(results[0]!.message.model).toBe('gemini-3-pro-preview');
		});

		it('handles cache: 0 (non-object) without dropping the message', async () => {
			await using fixture = await createFixture({});
			const dbPath = `${fixture.path}/opencode.db`;
			const db = new DatabaseSync(dbPath);
			db.exec(`CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE session (id TEXT, directory TEXT);`);
			db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
				'msg_c',
				'ses_c',
				1777388092686,
				1777388092686,
				JSON.stringify({ tokens: { input: 100, output: 50, cache: 0 }, modelID: 'deepseek-v4-pro' }),
			);
			db[Symbol.dispose]();

			const results = await processOpenCodeSessions(dbPath);
			expect(results).toHaveLength(1);
			expect(results[0]!.message.usage.cache_read_input_tokens).toBe(0);
			expect(results[0]!.message.usage.cache_creation_input_tokens).toBe(0);
		});

		it('skips messages without tokens or with all-zero tokens', async () => {
			await using fixture = await createFixture({});
			const dbPath = `${fixture.path}/opencode.db`;
			const db = new DatabaseSync(dbPath);
			db.exec(`CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE session (id TEXT, directory TEXT);`);
			const ins = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
			ins.run('no_tokens', 's', 1, 1, JSON.stringify({ role: 'user' }));
			ins.run('zero_tokens', 's', 2, 2, JSON.stringify({ tokens: { input: 0, output: 0, total: 0 }, modelID: 'deepseek-v4-pro' }));
			ins.run('valid', 's', 3, 3, JSON.stringify({ tokens: { input: 10, output: 5 }, modelID: 'deepseek-v4-pro' }));
			db[Symbol.dispose]();

			const results = await processOpenCodeSessions(dbPath);
			expect(results).toHaveLength(1);
			expect(results[0]!.message.usage.input_tokens).toBe(10);
		});

		it('skips messages without a modelID (cannot price, avoids mispricing)', async () => {
			await using fixture = await createFixture({});
			const dbPath = `${fixture.path}/opencode.db`;
			const db = new DatabaseSync(dbPath);
			db.exec(`CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE session (id TEXT, directory TEXT);`);
			const ins = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
			// Has tokens but no modelID — must be skipped (no fallback guess).
			ins.run('no_model', 's', 1, 1, JSON.stringify({ tokens: { input: 100, output: 50 } }));
			ins.run('blank_model', 's', 2, 2, JSON.stringify({ tokens: { input: 10, output: 5 }, modelID: '   ' }));
			ins.run('valid', 's', 3, 3, JSON.stringify({ tokens: { input: 20, output: 10 }, modelID: 'deepseek-v4-pro' }));
			db[Symbol.dispose]();

			const results = await processOpenCodeSessions(dbPath);
			expect(results).toHaveLength(1);
			expect(results[0]!.message.model).toBe('deepseek-v4-pro');
		});
	});

	describe('getOpenCodeDbPath', () => {
		it('returns empty string under VITEST when no env var is set', () => {
			const original = process.env.OPENCODE_DATA_DIR;
			delete process.env.OPENCODE_DATA_DIR;
			try {
				expect(getOpenCodeDbPath()).toBe('');
			}
			finally {
				if (original !== undefined) {
					process.env.OPENCODE_DATA_DIR = original;
				}
			}
		});

		it('respects the OPENCODE_DATA_DIR env var', () => {
			const original = process.env.OPENCODE_DATA_DIR;
			process.env.OPENCODE_DATA_DIR = '/custom/opencode';
			try {
				const p = getOpenCodeDbPath();
				expect(p).toContain('opencode.db');
				expect(p).toContain('custom');
			}
			finally {
				if (original === undefined) {
					delete process.env.OPENCODE_DATA_DIR;
				}
				else {
					process.env.OPENCODE_DATA_DIR = original;
				}
			}
		});
	});
}
