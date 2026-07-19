/**
 * @fileoverview Devin (Cognition) data adapter.
 *
 * Reads ATIF trajectory transcripts that the Devin CLI writes under its data
 * directory (`~/.local/share/devin/cli` on Linux/macOS, `%APPDATA%\devin\cli`
 * on Windows), and normalizes each billed step into the shared
 * {@link UsageData} shape so the unified better-ccusage loaders can aggregate
 * it alongside Claude/Droid/ZCode/Codex/OpenCode data.
 *
 * An optional `sessions.db` SQLite database (same data dir) enriches the
 * transcripts with the session's working directory, a model fallback, and
 * timestamps, and is also used to drop hidden sessions. When absent the
 * adapter degrades gracefully (transcripts-only).
 *
 * Cost handling: ATIF v1.7 records a per-step `committed_credit_cost` (USD)
 * in `step.metadata` (legacy: `step.extra`). We emit it as `costUSD` so the
 * `auto` cost mode (the default) uses it directly; `calculate` mode still
 * recomputes from tokens via the shared engine.
 *
 * Token handling is additive (the Claude model): the four buckets
 * (input/output/cache-create/cache-read) are independent and summed, with no
 * subtraction of cached tokens from input (unlike Codex, whose `input_tokens`
 * include the cached portion).
 *
 * Ported from upstream ccusage PR ccusage/ccusage#1398 (Rust).
 *
 * @module devin-adapter
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
	DEFAULT_DEVIN_HOME_PATH,
	DEFAULT_DEVIN_HOME_PATH_WIN,
	DEVIN_DATA_DIR_ENV,
	DEVIN_SESSIONS_DB_SUBPATH,
	DEVIN_TRANSCRIPT_GLOB,
	DEVIN_TRANSCRIPTS_SUBPATH,
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
 * Coerce a SQLite value (BigInt for INTEGER columns) or null/non-finite to a
 * safe number. Mirrors the OpenCode/ZCode adapter helper.
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
 * Normalize an ATIF timestamp value into an ISO string. Accepts either:
 *  - an epoch number: `< 1e10` is treated as seconds (multiplied by 1000),
 *    otherwise milliseconds (matches upstream's `format_sqlite_timestamp`);
 *  - an ISO-8601 string (returned as-is when already parseable).
 * Returns `null` when the value cannot be normalized.
 */
function normalizeTimestamp(raw: unknown): string | null {
	if (typeof raw === 'number' && Number.isFinite(raw)) {
		const ms = raw < 10_000_000_000 ? raw * 1000 : raw;
		if (ms < 0) {
			return null;
		}
		try {
			return new Date(ms).toISOString();
		}
		catch {
			return null;
		}
	}
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (trimmed === '') {
			return null;
		}
		// Integer-as-string (some Devin builds write epoch seconds as text).
		if (/^\d+$/.test(trimmed)) {
			return normalizeTimestamp(Number(trimmed));
		}
		const parsed = Date.parse(trimmed);
		if (!Number.isNaN(parsed)) {
			return new Date(parsed).toISOString();
		}
	}
	return null;
}

/**
 * First non-empty string in a list, trimmed; `undefined` if none. Used for
 * the model/timestamp/session-id resolution chains that mirror upstream.
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

/**
 * First non-empty value in a list of timestamp candidates (string or number),
 * `undefined` if none. Unlike {@link firstNonEmpty}, accepts numbers because
 * ATIF timestamps may be epoch seconds/millis; the caller normalizes via
 * {@link normalizeTimestamp}.
 */
function firstTimestampValue(values: Array<string | number | null | undefined>): string | number | undefined {
	for (const value of values) {
		if (value == null) {
			continue;
		}
		if (typeof value === 'number') {
			if (Number.isFinite(value)) {
				return value;
			}
			continue;
		}
		const trimmed = value.trim();
		if (trimmed !== '') {
			return trimmed;
		}
	}
	return undefined;
}

// --- ATIF transcript valibot schemas -------------------------------------

/**
 * A single ATIF step's token metrics (primary source, ATIF v1.7).
 * `cached_tokens` is a read cache hit; `extra.cache_creation_input_tokens`
 * holds the cache-write bucket (absent on most steps -> 0).
 */
const metricsExtraSchema = v.object({
	cache_creation_input_tokens: v.optional(v.number(), 0),
});
const metricsSchema = v.object({
	prompt_tokens: v.optional(v.number(), 0),
	completion_tokens: v.optional(v.number(), 0),
	cached_tokens: v.optional(v.number(), 0),
	extra: v.optional(metricsExtraSchema, {}),
});

/**
 * Legacy per-step metrics (`step.metadata.metrics`), used when
 * {@link metricsSchema} is absent. Field names differ from the primary schema
 * (snake_case `input_tokens`/`output_tokens` rather than `prompt_tokens`/
 * `completion_tokens`).
 */
const legacyMetricsSchema = v.object({
	input_tokens: v.optional(v.number(), 0),
	output_tokens: v.optional(v.number(), 0),
	cache_creation_tokens: v.optional(v.number(), 0),
	cache_read_tokens: v.optional(v.number(), 0),
});

const stepMetadataSchema = v.object({
	is_user_input: v.optional(v.boolean(), false),
	generation_model: v.optional(v.string()),
	committed_credit_cost: v.optional(v.number()),
	created_at: v.optional(v.union([v.string(), v.number()])),
	request_id: v.optional(v.string()),
	metrics: v.optional(legacyMetricsSchema),
});

const stepExtraSchema = v.object({
	generation_model: v.optional(v.string()),
	committed_credit_cost: v.optional(v.number()),
});

const stepSchema = v.object({
	timestamp: v.optional(v.union([v.string(), v.number()])),
	model_name: v.optional(v.string()),
	step_id: v.optional(v.string()),
	metrics: v.optional(metricsSchema),
	metadata: v.optional(stepMetadataSchema, {}),
	extra: v.optional(stepExtraSchema, {}),
});

const agentSchema = v.object({
	model_name: v.optional(v.string()),
});

const transcriptSchema = v.object({
	session_id: v.optional(v.string()),
	agent: v.optional(agentSchema, {}),
	steps: v.optional(v.array(stepSchema), []),
});

type DevinStep = v.InferOutput<typeof stepSchema>;

// --- sessions.db enrichment ----------------------------------------------

type SessionInfo = {
	workingDirectory: string | undefined;
	model: string | undefined;
	createdAt: string | undefined;
	lastActivityAt: string | undefined;
};

type SessionRow = {
	id: string;
	working_directory: string | null;
	model: string | null;
	created_at: number | bigint | string | null;
	last_activity_at: number | bigint | string | null;
	hidden: number | bigint | null;
};

const SESSIONS_SQL = `
	SELECT id, working_directory, model, created_at, last_activity_at, hidden
	FROM sessions
`;

/**
 * Load the Devin `sessions.db` enrichment map and the set of hidden session
 * ids. Returns empty containers when the DB is missing, unreadable, or the
 * runtime lacks `node:sqlite`; never throws.
 *
 * Hidden sessions (`hidden = 1`) are tracked separately so
 * {@link processDevinSessions} can skip their transcripts entirely — relying
 * only on omitting them from the map is insufficient because a transcript
 * that carries its own model (the normal case) would still be emitted.
 */
async function loadSessionInfo(dbPath: string): Promise<{ map: Map<string, SessionInfo>; hiddenIds: Set<string> }> {
	const map = new Map<string, SessionInfo>();
	const hiddenIds = new Set<string>();
	if (!existsSync(dbPath)) {
		return { map, hiddenIds };
	}
	let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
	try {
		({ DatabaseSync } = await import('node:sqlite'));
	}
	catch (error) {
		logger.warn(`node:sqlite is not available on this runtime; Devin sessions.db disabled. ${String(error)}`);
		return { map, hiddenIds };
	}
	let db: InstanceType<typeof DatabaseSync>;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
	}
	catch (error) {
		logger.warn(`Failed to open Devin sessions.db at ${dbPath}: ${String(error)}`);
		return { map, hiddenIds };
	}
	let rows: SessionRow[];
	try {
		rows = db.prepare(SESSIONS_SQL).all() as SessionRow[];
	}
	catch (error) {
		logger.warn(`Failed to query Devin sessions table: ${String(error)}`);
		db[Symbol.dispose]();
		return { map, hiddenIds };
	}
	db[Symbol.dispose]();

	for (const row of rows) {
		const id = row.id?.trim();
		if (id === undefined || id === '') {
			continue;
		}
		// `hidden` is 0/1 (INTEGER); treat truthy non-zero as hidden.
		if (toFiniteNumber(row.hidden) !== 0) {
			hiddenIds.add(id);
			continue;
		}
		map.set(id, {
			workingDirectory: firstNonEmpty([row.working_directory]),
			model: firstNonEmpty([row.model]),
			createdAt: normalizeTimestamp(row.created_at) ?? undefined,
			lastActivityAt: normalizeTimestamp(row.last_activity_at) ?? undefined,
		});
	}
	return { map, hiddenIds };
}

// --- per-step resolution helpers -----------------------------------------

/**
 * Resolve a step's token usage. Returns `null` when no metrics are present.
 * The primary ATIF v1.7 path reads `step.metrics`; the legacy path reads
 * `step.metadata.metrics`. Output is normalized to the Claude bucket names.
 */
function stepUsage(step: DevinStep): {
	input: number;
	output: number;
	cacheCreation: number;
	cacheRead: number;
} | null {
	if (step.metrics != null) {
		const m = step.metrics;
		return {
			input: m.prompt_tokens,
			output: m.completion_tokens,
			cacheRead: m.cached_tokens,
			cacheCreation: m.extra.cache_creation_input_tokens,
		};
	}
	const legacy = step.metadata.metrics;
	if (legacy != null) {
		return {
			input: legacy.input_tokens,
			output: legacy.output_tokens,
			cacheCreation: legacy.cache_creation_tokens,
			cacheRead: legacy.cache_read_tokens,
		};
	}
	return null;
}

/**
 * Total tokens across all four buckets. Matches upstream's
 * `total_usage_tokens`. Used to skip zero-token steps.
 */
function totalTokens(usage: { input: number; output: number; cacheCreation: number; cacheRead: number }): number {
	return usage.input + usage.output + usage.cacheCreation + usage.cacheRead;
}

// --- path resolution -----------------------------------------------------

/**
 * Get the Devin data directory.
 *
 * Resolution order (mirrors upstream `devin/paths.rs`):
 * 1. `DEVIN_DATA_DIR` env var (used as-is when non-empty)
 * 2. Sentinel `''` under VITEST (signals callers to skip the source)
 * 3. Default: `%APPDATA%\devin\cli` on Windows when `APPDATA` is set,
 *    otherwise `~/.local/share/devin/cli`
 *
 * Returns the directory even when it does not exist on disk; callers handle
 * a missing directory gracefully.
 */
export function getDevinPath(): string {
	const envDir = process.env[DEVIN_DATA_DIR_ENV]?.trim();
	if (envDir != null && envDir !== '') {
		return path.resolve(envDir);
	}

	if (process.env.VITEST != null) {
		return '';
	}

	const appdata = process.env.APPDATA;
	if (appdata != null && appdata.trim() !== '') {
		return path.join(appdata, DEFAULT_DEVIN_HOME_PATH_WIN);
	}

	return path.join(USER_HOME_DIR, DEFAULT_DEVIN_HOME_PATH);
}

// --- main entry point ----------------------------------------------------

/**
 * Read every ATIF transcript under `<dataDir>/transcripts/` and transform
 * each billable step into a {@link UsageData} entry.
 *
 * `sessions.db` (SQLite, optional) enriches each transcript with the session's
 * working directory, a model fallback, and timestamp fallbacks, and filters
 * hidden sessions. User-input steps and zero-token steps are skipped.
 *
 * @param dataDir - Absolute path to the Devin CLI data directory
 * @param _options - Load options (kept for parity with the other adapters)
 * @returns Transformed usage entries (one per billable step)
 */
export async function processDevinSessions(
	dataDir: string,
	_options: LoadOptions = {},
): Promise<UsageData[]> {
	if (dataDir === '') {
		logger.debug('Devin data directory is empty, skipping');
		return [];
	}

	const transcriptsDir = path.join(dataDir, DEVIN_TRANSCRIPTS_SUBPATH);
	if (!existsSync(transcriptsDir)) {
		// warn (not debug): a missing transcripts dir is the most common reason
		// Devin data is invisible in reports, and debug is hidden by default.
		logger.warn(`Devin transcripts directory not found at ${transcriptsDir}`);
		return [];
	}

	// Optional SQLite enrichment (never fatal when absent/unreadable).
	const sessionsDb = path.join(dataDir, DEVIN_SESSIONS_DB_SUBPATH);
	const { map: sessionInfo, hiddenIds } = await loadSessionInfo(sessionsDb);

	const files = await glob(DEVIN_TRANSCRIPT_GLOB, {
		cwd: transcriptsDir,
		absolute: true,
	});

	const results: UsageData[] = [];
	for (const file of files) {
		let content: string;
		try {
			content = await readFile(file, 'utf-8');
		}
		catch (error) {
			logger.debug(`Failed to read Devin transcript ${file}: ${String(error)}`);
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		}
		catch (error) {
			logger.debug(`Failed to parse Devin transcript ${file}: ${String(error)}`);
			continue;
		}

		const transcriptResult = v.safeParse(transcriptSchema, parsed);
		if (!transcriptResult.success) {
			continue;
		}
		const transcript = transcriptResult.output;

		// Session id: transcript field -> sessions.db -> filename stem.
		const filenameSessionId = path.basename(file, path.extname(file));
		const sessionIdRaw = firstNonEmpty([transcript.session_id, filenameSessionId]);
		const sessionId = sessionIdRaw ?? filenameSessionId;

		// Skip hidden sessions: the sessions.db flags them with hidden = 1 and
		// their transcripts must be dropped entirely (not just unenriched),
		// since a transcript carrying its own model would otherwise still be
		// emitted despite being hidden.
		if (hiddenIds.has(sessionId)) {
			continue;
		}

		const info = sessionInfo.get(sessionId);

		// Transcript-level fallback model (shared by every step).
		const transcriptModel = firstNonEmpty([transcript.agent.model_name, info?.model]);

		for (const step of transcript.steps) {
			// Skip user-input steps (they carry no token usage anyway).
			if (step.metadata.is_user_input) {
				continue;
			}

			const usage = stepUsage(step);
			if (usage == null) {
				continue;
			}
			if (totalTokens(usage) === 0) {
				continue;
			}

			// Model resolution (first non-empty wins), mirroring upstream.
			const modelRaw = firstNonEmpty([
				step.metadata.generation_model,
				step.extra.generation_model,
				step.model_name,
				transcriptModel,
			]);
			if (modelRaw === undefined) {
				// Without a model we cannot price; skip rather than guess.
				continue;
			}

			// Timestamp resolution (first non-empty wins).
			const timestampRaw = firstTimestampValue([
				step.metadata.created_at,
				step.timestamp,
				info?.lastActivityAt,
				info?.createdAt,
			]);
			const timestamp = normalizeTimestamp(timestampRaw);
			if (timestamp === null) {
				continue;
			}

			// Per-step USD cost (committed_credit_cost). Optional.
			const costUSD = step.metadata.committed_credit_cost ?? step.extra.committed_credit_cost;

			// Stable message id: step's request id, else step id, else a
			// composite that includes the token counts. Including the counts
			// (matching upstream's `entry_id` shape) keeps two no-id steps
			// sharing the same timestamp distinct instead of being deduped to
			// one entry by the loader.
			const uniqueId = firstNonEmpty([step.metadata.request_id, step.step_id])
				?? `${sessionId}#${timestamp}#${usage.input}:${usage.output}`;

			// Project label for the virtual cwd root: derive the basename from
			// the sessions.db working directory (matches upstream's
			// `project_name_from_path`) rather than joining the absolute path,
			// which would be mangled by path.join stripping a leading
			// separator. Fall back to the session id when no working dir is
			// known so sessions stay distinguishable.
			const workingDir = info?.workingDirectory;
			let projectLabel = sessionId;
			if (workingDir != null && workingDir !== '') {
				const base = path.basename(workingDir);
				projectLabel = base !== '' ? base : sessionId;
			}

			const entry: UsageData = {
				timestamp: createISOTimestamp(timestamp),
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
				// Virtual cwd root so Devin sessions are distinguishable, keyed
				// by the project name (basename) when known, else session id.
				cwd: path.join('devin', projectLabel),
				source: createSource('devin'),
			};
			results.push(entry);
		}
	}

	logger.info(`Loaded ${results.length} Devin usage entries from ${transcriptsDir} (${files.length} transcript file${files.length === 1 ? '' : 's'})`);

	// Surface the "transcripts exist but nothing extracted" case so Devin being
	// invisible in reports is diagnosable instead of silent.
	if (results.length === 0 && files.length > 0) {
		logger.warn(
			`Devin transcripts directory at ${transcriptsDir} had ${files.length} file(s) but none yielded usage entries. Transcripts without token/step data or with an unrecognized schema are skipped.`,
		);
	}

	return results;
}

if (import.meta.vitest != null) {
	// Hoist the sqlite import once for all tests (CLAUDE.md discourages
	// repeated `await import()` in test bodies; the runtime-detection
	// justification from the production code does not apply under vitest).
	// eslint-disable-next-line antfu/no-top-level-await -- test-only hoisted import inside the vitest guard
	const { DatabaseSync } = await import('node:sqlite');

	/**
	 * Build a sessions.db at `<fixture>/sessions.db` with the given rows and
	 * return the absolute db path. Keeps per-test session-enrichment setup
	 * terse; columns mirror upstream's `sessions` table.
	 */
	async function writeSessionsDb(
		fixturePath: string,
		rows: Array<{
			id: string;
			working_directory?: string | null;
			model?: string | null;
			created_at?: number | null;
			last_activity_at?: number | null;
			hidden?: number;
		}>,
	): Promise<string> {
		const dbPath = `${fixturePath}/${DEVIN_SESSIONS_DB_SUBPATH}`;
		const db = new DatabaseSync(dbPath);
		db.exec('CREATE TABLE sessions (id TEXT, working_directory TEXT, model TEXT, created_at INTEGER, last_activity_at INTEGER, hidden INTEGER)');
		const ins = db.prepare('INSERT INTO sessions (id, working_directory, model, created_at, last_activity_at, hidden) VALUES (?, ?, ?, ?, ?, ?)');
		for (const row of rows) {
			ins.run(
				row.id,
				row.working_directory ?? null,
				row.model ?? null,
				row.created_at ?? null,
				row.last_activity_at ?? null,
				row.hidden ?? 0,
			);
		}
		db[Symbol.dispose]();
		return dbPath;
	}

	describe('processDevinSessions', () => {
		it('parses ATIF v1.7 steps with primary metrics into UsageData (additive)', async () => {
			await using fixture = await createFixture({
				[DEVIN_TRANSCRIPTS_SUBPATH]: {
					'abc123.json': JSON.stringify({
						session_id: 'abc123',
						agent: { model_name: 'sonnet-4-6' },
						steps: [
							{
								timestamp: '2026-07-03T10:00:00Z',
								model_name: 'sonnet-4-6',
								step_id: 'step_1',
								metrics: {
									prompt_tokens: 1000,
									completion_tokens: 200,
									cached_tokens: 500,
									extra: { cache_creation_input_tokens: 50 },
								},
								metadata: { committed_credit_cost: 0.012 },
							},
							// User-input step: must be skipped.
							{ timestamp: '2026-07-03T10:05:00Z', metadata: { is_user_input: true, metrics: { input_tokens: 1 } } },
							// Zero-token step: must be skipped.
							{ timestamp: '2026-07-03T10:10:00Z', metrics: { prompt_tokens: 0, completion_tokens: 0 } },
						],
					}),
				},
			});

			const results = await processDevinSessions(fixture.path);
			expect(results).toHaveLength(1);
			const entry = results[0]!;
			expect(entry.source).toBe('devin');
			expect(entry.sessionId).toBe('abc123');
			expect(entry.message.model).toBe('sonnet-4-6');
			// Additive model: all four buckets kept, no subtraction.
			expect(entry.message.usage.input_tokens).toBe(1000);
			expect(entry.message.usage.output_tokens).toBe(200);
			expect(entry.message.usage.cache_creation_input_tokens).toBe(50);
			expect(entry.message.usage.cache_read_input_tokens).toBe(500);
			expect(entry.costUSD).toBeCloseTo(0.012);
			expect(entry.cwd).toBe(path.join('devin', 'abc123'));
		});

		it('falls back to legacy step.metadata.metrics when step.metrics is absent', async () => {
			await using fixture = await createFixture({
				[DEVIN_TRANSCRIPTS_SUBPATH]: {
					'legacy.json': JSON.stringify({
						steps: [
							{
								timestamp: '2026-07-03T10:00:00Z',
								model_name: 'm',
								metadata: {
									metrics: {
										input_tokens: 300,
										output_tokens: 80,
										cache_creation_tokens: 20,
										cache_read_tokens: 10,
									},
								},
							},
						],
					}),
				},
			});

			const results = await processDevinSessions(fixture.path);
			expect(results).toHaveLength(1);
			const usage = results[0]!.message.usage;
			expect(usage.input_tokens).toBe(300);
			expect(usage.output_tokens).toBe(80);
			expect(usage.cache_creation_input_tokens).toBe(20);
			expect(usage.cache_read_input_tokens).toBe(10);
		});

		it('enriches with sessions.db (working directory, model fallback, hidden filter)', async () => {
			await using fixture = await createFixture({
				[DEVIN_TRANSCRIPTS_SUBPATH]: {
					// No session_id field -> filename stem used; no agent model
					// -> sessions.db model fallback applies.
					'sess_visible.json': JSON.stringify({
						steps: [
							{
								timestamp: '2026-07-03T10:00:00Z',
								metrics: { prompt_tokens: 100, completion_tokens: 10 },
							},
						],
					}),
					// A hidden session flagged hidden=1 in sessions.db. Critically
					// this transcript CARRIES its own model (the normal case) so
					// it would be emitted if we only dropped it from the
					// enrichment map — it must be skipped by explicit id tracking.
					'sess_hidden.json': JSON.stringify({
						agent: { model_name: 'sonnet-4-6' },
						steps: [{
							timestamp: '2026-07-03T10:00:00Z',
							model_name: 'sonnet-4-6',
							metrics: { prompt_tokens: 5, completion_tokens: 1 },
						}],
					}),
				},
			});

			await writeSessionsDb(fixture.path, [
				{ id: 'sess_visible', working_directory: '/home/user/proj', model: 'kimi-k2-7', last_activity_at: 1782000100 },
				{ id: 'sess_hidden', hidden: 1 },
			]);

			const results = await processDevinSessions(fixture.path);
			expect(results).toHaveLength(1);
			const entry = results[0]!;
			// sessions.db model fallback applied (no step/transcript model).
			expect(entry.message.model).toBe('kimi-k2-7');
			// working_directory basename carried as the project cwd (not the
			// full absolute path, which path.join would mangle).
			expect(entry.cwd).toBe(path.join('devin', 'proj'));
			expect(entry.sessionId).toBe('sess_visible');
		});

		it('normalizes epoch-seconds and epoch-millis timestamps from sessions.db', async () => {
			await using fixture = await createFixture({
				[DEVIN_TRANSCRIPTS_SUBPATH]: {
					// Step has no timestamp; fallback to sessions.db last_activity_at.
					'ts.json': JSON.stringify({
						steps: [{ model_name: 'm', metrics: { prompt_tokens: 10 } }],
					}),
				},
			});

			// 1782000100 seconds -> a valid date in 2026.
			await writeSessionsDb(fixture.path, [{ id: 'ts', model: 'm', last_activity_at: 1782000100 }]);

			const results = await processDevinSessions(fixture.path);
			expect(results).toHaveLength(1);
			expect(results[0]!.timestamp).toBe(new Date(1782000100 * 1000).toISOString());
		});

		it('skips steps with no resolvable model (cannot price, avoids mispricing)', async () => {
			await using fixture = await createFixture({
				[DEVIN_TRANSCRIPTS_SUBPATH]: {
					'nomodel.json': JSON.stringify({
						steps: [{ timestamp: '2026-07-03T10:00:00Z', metrics: { prompt_tokens: 50 } }],
					}),
				},
			});

			const results = await processDevinSessions(fixture.path);
			expect(results).toHaveLength(0);
		});

		it('returns empty when the transcripts directory is missing', async () => {
			await using fixture = await createFixture({});
			const results = await processDevinSessions(fixture.path);
			expect(results).toEqual([]);
		});

		it('returns empty for the empty-path sentinel', async () => {
			const results = await processDevinSessions('');
			expect(results).toEqual([]);
		});

		it('handles a malformed transcript file without throwing', async () => {
			await using fixture = await createFixture({
				[DEVIN_TRANSCRIPTS_SUBPATH]: {
					'broken.json': '{ not valid json',
					'good.json': JSON.stringify({
						steps: [{ timestamp: '2026-07-03T10:00:00Z', model_name: 'm', metrics: { prompt_tokens: 1 } }],
					}),
				},
			});

			const results = await processDevinSessions(fixture.path);
			expect(results).toHaveLength(1);
		});
	});

	describe('getDevinPath', () => {
		it('returns empty string under VITEST when no env var is set', () => {
			const originalEnv = process.env.DEVIN_DATA_DIR;
			const originalAppdata = process.env.APPDATA;
			delete process.env.DEVIN_DATA_DIR;
			delete process.env.APPDATA;
			try {
				expect(getDevinPath()).toBe('');
			}
			finally {
				if (originalEnv !== undefined) {
					process.env.DEVIN_DATA_DIR = originalEnv;
				}
				if (originalAppdata !== undefined) {
					process.env.APPDATA = originalAppdata;
				}
			}
		});

		it('respects the DEVIN_DATA_DIR env var', () => {
			const original = process.env.DEVIN_DATA_DIR;
			process.env.DEVIN_DATA_DIR = '/custom/devin';
			try {
				expect(getDevinPath()).toBe(path.resolve('/custom/devin'));
			}
			finally {
				if (original === undefined) {
					delete process.env.DEVIN_DATA_DIR;
				}
				else {
					process.env.DEVIN_DATA_DIR = original;
				}
			}
		});
	});

	describe('normalizeTimestamp', () => {
		it('treats small numbers as epoch seconds', () => {
			expect(normalizeTimestamp(1782000100)).toBe(new Date(1782000100 * 1000).toISOString());
		});
		it('treats large numbers as epoch millis', () => {
			expect(normalizeTimestamp(1782000100000)).toBe(new Date(1782000100000).toISOString());
		});
		it('parses ISO strings', () => {
			expect(normalizeTimestamp('2026-07-03T10:00:00Z')).toBe('2026-07-03T10:00:00.000Z');
		});
		it('parses epoch-seconds-as-string', () => {
			expect(normalizeTimestamp('1782000100')).toBe(new Date(1782000100 * 1000).toISOString());
		});
		it('returns null for garbage', () => {
			expect(normalizeTimestamp('not a date')).toBeNull();
			expect(normalizeTimestamp(undefined)).toBeNull();
			expect(normalizeTimestamp(null)).toBeNull();
		});
	});
}
