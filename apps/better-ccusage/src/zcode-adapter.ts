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
 * `input_tokens` is the **total** prompt tokens billed at the input rate; the
 * cached share (`cache_read_input_tokens`) is a subset of it and is priced
 * separately at the cached rate. `output_tokens` already includes any
 * reasoning charge. See the project CLAUDE.md for the full mapping table.
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

		const inputTokens = toFiniteNumber(row.input_tokens);
		const cacheReadTokens = toFiniteNumber(row.cache_read_input_tokens);
		const cacheCreationTokens = toFiniteNumber(row.cache_creation_input_tokens);
		const outputTokens = toFiniteNumber(row.output_tokens);
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
