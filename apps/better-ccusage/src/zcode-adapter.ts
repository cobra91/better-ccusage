/**
 * @fileoverview ZCode data adapter for processing ZCode session usage from SQLite
 *
 * ZCode (the official GLM coding tool) records every model request as a row in
 * a SQLite database at `~/.zcode/cli/db/db.sqlite` (table `model_usage`).
 * Unlike Claude/Droid (JSONL), this adapter reads the database directly via
 * `node:sqlite` and transforms each row into the {@link UsageData} shape so it
 * merges transparently with Claude + Droid entries in the shared loaders.
 *
 * Each `model_usage` row maps to one `UsageData` entry: one row = one billable
 * model request (a single turn may emit several rows). Retries are distinct
 * rows keyed by `(logical_request_id, attempt_index)` and are counted as
 * independent requests, matching how the provider bills them.
 *
 * @module zcode-adapter
 */

import type { LoadOptions, UsageData } from './data-loader.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createFixture } from 'fs-fixture';
import { DEFAULT_ZCODE_DB_SUBPATH, DEFAULT_ZCODE_HOME_PATH, USER_HOME_DIR, ZCODE_HOME_ENV } from './_consts.ts';
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
 * Raw shape of a `model_usage` row joined with its `session`.
 *
 * `input_tokens` follows the OpenAI convention: it is the **total** prompt
 * size, and the cached share (`cache_read_input_tokens`,
 * `cache_creation_input_tokens`) is a subset of it. The Claude usage schema
 * consumed downstream expects fresh (non-cached) input, so the adapter must
 * subtract the cached buckets before emitting the entry — otherwise cached
 * tokens are billed at the full input rate on top of their cache rate.
 * `output_tokens` already includes any reasoning charge.
 */
type ModelUsageRow = {
	started_at: number | bigint;
	session_id: string;
	model_id: string | null;
	input_tokens: number | bigint;
	cache_read_input_tokens: number | bigint;
	cache_creation_input_tokens: number | bigint;
	output_tokens: number | bigint;
	logical_request_id: string | null;
	attempt_index: number | bigint | null;
	directory: string | null;
};

function toFiniteNumber(value: number | bigint | null | undefined): number {
	if (value == null) {
		return 0;
	}
	if (typeof value === 'bigint') {
		return Number(value);
	}
	return Number.isFinite(value) ? value : 0;
}

const MODEL_USAGE_SQL = /* sql */ `
	SELECT
		mu.started_at,
		mu.session_id,
		mu.model_id,
		mu.input_tokens,
		mu.cache_read_input_tokens,
		mu.cache_creation_input_tokens,
		mu.output_tokens,
		mu.logical_request_id,
		mu.attempt_index,
		s.directory
	FROM model_usage AS mu
	LEFT JOIN session AS s ON s.id = mu.session_id
	WHERE mu.input_tokens > 0
		OR mu.output_tokens > 0
		OR mu.cache_read_input_tokens > 0
		OR mu.cache_creation_input_tokens > 0
	ORDER BY mu.started_at ASC
`;

/**
 * Resolve the path to the ZCode SQLite database.
 *
 * Honors the `ZCODE_HOME` environment variable (resolved against the working
 * directory when relative), otherwise falls back to `~/.zcode/cli/db/db.sqlite`.
 */
export function getZcodeDbPath(): string {
	const envHome = process.env[ZCODE_HOME_ENV]?.trim();
	if (envHome != null && envHome !== '') {
		return path.resolve(envHome, DEFAULT_ZCODE_DB_SUBPATH);
	}

	if (process.env.VITEST != null) {
		return '';
	}

	return path.join(USER_HOME_DIR, DEFAULT_ZCODE_HOME_PATH, DEFAULT_ZCODE_DB_SUBPATH);
}

/**
 * Read all model-usage rows from the ZCode SQLite database and transform them
 * into {@link UsageData} entries.
 *
 * The database is opened **read-only** so it never contends with the running
 * ZCode process writing to the same file (SQLite handles concurrent WAL
 * readers natively). Cost is intentionally NOT computed here — the shared
 * loaders apply pricing downstream via `calculateCostForEntry`, exactly like
 * the Droid adapter.
 *
 * @param dbPath - Absolute path to the ZCode SQLite database
 * @returns Transformed usage entries (one per `model_usage` row)
 */
export async function processZcodeSessions(dbPath: string, _options: LoadOptions = {}): Promise<UsageData[]> {
	if (dbPath === '') {
		logger.debug('ZCode database path is empty, skipping');
		return [];
	}

	if (!existsSync(dbPath)) {
		logger.debug(`ZCode database not found at ${dbPath}`);
		return [];
	}

	// Lazy-import node:sqlite so the module loads on runtimes that lack it
	// (e.g. Bun, used by the schema generator) and on Node < 22.13. Only the
	// actual ZCode code path triggers the import.
	let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
	try {
		({ DatabaseSync } = await import('node:sqlite'));
	}
	catch (error) {
		logger.warn(`node:sqlite is not available on this runtime; ZCode usage disabled. ${String(error)}`);
		return [];
	}

	let db: InstanceType<typeof DatabaseSync>;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
	}
	catch (error) {
		logger.warn(`Failed to open ZCode database at ${dbPath}: ${String(error)}`);
		return [];
	}

	let rows: ModelUsageRow[];
	try {
		const statement = db.prepare(MODEL_USAGE_SQL);
		rows = statement.all() as ModelUsageRow[];
	}
	catch (error) {
		logger.warn(`Failed to query ZCode model_usage table: ${String(error)}`);
		db[Symbol.dispose]();
		return [];
	}

	db[Symbol.dispose]();

	const results: UsageData[] = [];
	for (const row of rows) {
		const modelRaw = row.model_id?.trim();
		if (modelRaw == null || modelRaw === '') {
			// Without a model name we cannot price the row; skip it.
			continue;
		}

		const totalInputTokens = toFiniteNumber(row.input_tokens);
		const cacheReadTokens = toFiniteNumber(row.cache_read_input_tokens);
		const cacheCreationTokens = toFiniteNumber(row.cache_creation_input_tokens);
		const outputTokens = toFiniteNumber(row.output_tokens);
		// Total prompt minus the cached buckets = fresh input. Clamp at zero in
		// case a provider ever reports inconsistent counters.
		const inputTokens = Math.max(0, totalInputTokens - cacheReadTokens - cacheCreationTokens);
		// ZCode tracks reasoning_tokens separately, but they are already included
		// in output_tokens for billing, so we do not surface them in the usage
		// object (the Claude schema has no field for it).
		const timestamp = new Date(toFiniteNumber(row.started_at)).toISOString();

		const sessionId = row.session_id ?? 'unknown-session';
		// Stable message id so dedup keys are unique per request/attempt.
		const logicalId = row.logical_request_id ?? sessionId;
		const attemptIndex = toFiniteNumber(row.attempt_index);
		const messageId = attemptIndex > 0 ? `${logicalId}#${attemptIndex}` : logicalId;

		// ZCode's directory is the absolute working directory the session ran in.
		// Group it under a `zcode` virtual root so it is distinguishable from
		// Claude/Droid project paths, while keeping the real dir visible.
		const cwd = row.directory != null && row.directory !== ''
			? path.join('zcode', row.directory)
			: path.join('zcode', 'unknown');

		const entry: UsageData = {
			timestamp: createISOTimestamp(timestamp),
			sessionId: createSessionId(sessionId),
			version: createVersion('1.0.0'),
			message: {
				usage: {
					input_tokens: inputTokens,
					output_tokens: outputTokens,
					cache_creation_input_tokens: cacheCreationTokens,
					cache_read_input_tokens: cacheReadTokens,
				},
				model: createModelName(modelRaw),
				id: createMessageId(messageId),
			},
			// Cost will be calculated by better-ccusage based on model pricing.
			requestId: createRequestId(messageId),
			cwd,
			source: createSource('zcode'),
		};

		results.push(entry);
	}

	logger.info(`Loaded ${results.length} ZCode usage entries from ${dbPath}`);
	return results;
}

if (import.meta.vitest != null) {
	// Hoist the sqlite import once for all tests (matches the OpenCode adapter
	// test block; the runtime-detection justification above does not apply
	// under vitest).
	// eslint-disable-next-line antfu/no-top-level-await -- test-only hoisted import inside the vitest guard
	const { DatabaseSync } = await import('node:sqlite');

	describe('processZcodeSessions', () => {
		async function buildZcodeDb(dir: string): Promise<string> {
			const dbPath = `${dir}/zcode.db`;
			const db = new DatabaseSync(dbPath);
			db.exec(`
				CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
				CREATE TABLE model_usage (
					id TEXT PRIMARY KEY,
					logical_request_id TEXT,
					attempt_index INTEGER NOT NULL DEFAULT 0,
					session_id TEXT NOT NULL,
					model_id TEXT NOT NULL,
					started_at INTEGER NOT NULL,
					input_tokens INTEGER NOT NULL DEFAULT 0,
					output_tokens INTEGER NOT NULL DEFAULT 0,
					cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
					cache_read_input_tokens INTEGER NOT NULL DEFAULT 0
				);
			`);
			db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run('ses_1', '/home/user/projects/app');
			db[Symbol.dispose]();
			return dbPath;
		}

		it('bills fresh input only: total prompt minus cached read', async () => {
			await using fixture = await createFixture({});
			const dbPath = await buildZcodeDb(fixture.path);
			const db = new DatabaseSync(dbPath);
			db.prepare(
				`INSERT INTO model_usage
					(id, logical_request_id, attempt_index, session_id, model_id, started_at, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run('mu_1', 'req_1', 0, 'ses_1', 'GLM-5.3', 1777388092686, 259329, 1257, 0, 258112);
			db[Symbol.dispose]();

			const results = await processZcodeSessions(dbPath);

			expect(results).toHaveLength(1);
			const usage = results[0]!.message.usage;
			// input_tokens is the TOTAL prompt (259,329 incl. 258,112 cached);
			// only the 1,217 fresh tokens may be billed at the input rate.
			expect(usage.input_tokens).toBe(1217);
			expect(usage.cache_read_input_tokens).toBe(258112);
			expect(usage.cache_creation_input_tokens).toBe(0);
			expect(usage.output_tokens).toBe(1257);
			expect(results[0]!.source).toBe('zcode');
		});

		it('subtracts cache creation alongside cache read', async () => {
			await using fixture = await createFixture({});
			const dbPath = await buildZcodeDb(fixture.path);
			const db = new DatabaseSync(dbPath);
			db.prepare(
				`INSERT INTO model_usage
					(id, logical_request_id, attempt_index, session_id, model_id, started_at, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run('mu_2', 'req_2', 0, 'ses_1', 'GLM-5.3', 1777388092686, 1000, 500, 300, 200);
			db[Symbol.dispose]();

			const results = await processZcodeSessions(dbPath);

			expect(results).toHaveLength(1);
			const usage = results[0]!.message.usage;
			expect(usage.input_tokens).toBe(500);
			expect(usage.cache_read_input_tokens).toBe(200);
			expect(usage.cache_creation_input_tokens).toBe(300);
			expect(usage.output_tokens).toBe(500);
		});

		it('clamps fresh input at zero when counters are inconsistent', async () => {
			await using fixture = await createFixture({});
			const dbPath = await buildZcodeDb(fixture.path);
			const db = new DatabaseSync(dbPath);
			db.prepare(
				`INSERT INTO model_usage
					(id, logical_request_id, attempt_index, session_id, model_id, started_at, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run('mu_3', 'req_3', 0, 'ses_1', 'GLM-5.3', 1777388092686, 100, 10, 0, 250);
			db[Symbol.dispose]();

			const results = await processZcodeSessions(dbPath);

			expect(results).toHaveLength(1);
			expect(results[0]!.message.usage.input_tokens).toBe(0);
			expect(results[0]!.message.usage.cache_read_input_tokens).toBe(250);
		});
	});
}
