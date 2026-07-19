/**
 * @fileoverview OpenAI Codex CLI data adapter.
 *
 * Parses Codex session JSONL logs (turn_context + event_msg/token_count entries)
 * and normalizes them into the shared {@link UsageData} shape so the unified
 * better-ccusage loaders can aggregate them alongside Claude/Droid/ZCode data.
 *
 * Codex usage counters are **cumulative** within a session, so each file is
 * walked in order and per-event deltas are derived by subtracting the previous
 * `total_token_usage` snapshot. Cost is intentionally NOT computed here — the
 * shared loaders apply pricing downstream via `calculateCostForEntry`, exactly
 * like the Droid and ZCode adapters.
 *
 * @module codex-adapter
 */

import type { LoadOptions, UsageData } from './data-loader.ts';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import {
	CODEX_HOME_ENV,
	CODEX_SESSION_GLOB,
	DEFAULT_CODEX_HOME_PATH,
	DEFAULT_CODEX_SESSIONS_SUBPATH,
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
 * Fallback model when a Codex log entry lacks any model metadata. Codex's own
 * default is the GPT-5 family, so we mirror that rather than emitting
 * "unknown" (which would yield $0 and silently understate cost).
 */
const LEGACY_FALLBACK_MODEL = 'gpt-5';

/**
 * Map a Codex-reported model name to a name the shared pricing fetcher
 * recognizes. `gpt-5-codex` is priced identically to `gpt-5` in the LiteLLM
 * dataset (and the alias is a safety net for older logs).
 */
const CODEX_MODEL_ALIASES = new Map<string, string>([
	['gpt-5-codex', 'gpt-5'],
]);

/**
 * Normalized per-event usage before branding/renaming to the Claude shape.
 */
type RawUsage = {
	input_tokens: number;
	cached_input_tokens: number;
	output_tokens: number;
	reasoning_output_tokens: number;
	total_tokens: number;
};

function ensureNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Normalize a Codex `token_count` payload into a predictable shape.
 *
 * Codex reports four counters:
 *   - input_tokens
 *   - cached_input_tokens (a.k.a cache_read_input_tokens)
 *   - output_tokens (this already includes any reasoning charge)
 *   - reasoning_output_tokens (informational only — already in output_tokens)
 *
 * Modern JSONL entries also provide `total_tokens`, but legacy ones may omit
 * it. When that happens we mirror Codex' billing behavior and synthesize
 * `input + output` (reasoning is part of output, not an extra charge).
 */
function normalizeRawUsage(value: unknown): RawUsage | null {
	if (value == null || typeof value !== 'object') {
		return null;
	}

	const record = value as Record<string, unknown>;
	const input = ensureNumber(record.input_tokens);
	const cached = ensureNumber(record.cached_input_tokens ?? record.cache_read_input_tokens);
	const output = ensureNumber(record.output_tokens);
	const reasoning = ensureNumber(record.reasoning_output_tokens);
	const total = ensureNumber(record.total_tokens);

	return {
		input_tokens: input,
		cached_input_tokens: cached,
		output_tokens: output,
		reasoning_output_tokens: reasoning,
		total_tokens: total > 0 ? total : input + output,
	};
}

/**
 * Convert a cumulative snapshot into a per-event delta by subtracting the
 * previous snapshot. Each field is clamped at zero (counters never decrease,
 * but a reset between sessions could otherwise yield negative deltas).
 */
function subtractRawUsage(current: RawUsage, previous: RawUsage | null): RawUsage {
	return {
		input_tokens: Math.max(current.input_tokens - (previous?.input_tokens ?? 0), 0),
		cached_input_tokens: Math.max(current.cached_input_tokens - (previous?.cached_input_tokens ?? 0), 0),
		output_tokens: Math.max(current.output_tokens - (previous?.output_tokens ?? 0), 0),
		reasoning_output_tokens: Math.max(current.reasoning_output_tokens - (previous?.reasoning_output_tokens ?? 0), 0),
		total_tokens: Math.max(current.total_tokens - (previous?.total_tokens ?? 0), 0),
	};
}

/**
 * Map a normalized Codex delta onto the Claude token model.
 *
 * Codex/OpenAI reports `cached_input_tokens` as a **subset of** `input_tokens`,
 * but the shared Claude cost engine (`calculateCostFromPricing`) treats
 * `input_tokens` and `cache_read_input_tokens` as **separate additive buckets**
 * (mirroring the Anthropic billing shape). To avoid double-charging cached
 * tokens — once at the full input rate, once at the cache-read rate — we must
 * subtract `cached` from `input_tokens` so the additive sum matches real
 * Codex/OpenAI billing: `(input − cached) × input_price + cached × cache_read_price`.
 *
 * Reasoning tokens have no Claude equivalent and are dropped (they are already
 * included in output for billing).
 */
function toClaudeUsage(raw: RawUsage): {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
} {
	const cached = Math.min(raw.cached_input_tokens, raw.input_tokens);
	return {
		// Subtract cached tokens so the additive cost engine does not charge
		// them twice (full input rate + cache-read rate). Without this, Codex
		// costs would be inflated in proportion to the cache-hit ratio.
		input_tokens: Math.max(raw.input_tokens - cached, 0),
		output_tokens: raw.output_tokens,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: cached,
	};
}

const recordSchema = v.record(v.string(), v.unknown());

const entrySchema = v.object({
	type: v.string(),
	payload: v.optional(v.unknown()),
	timestamp: v.optional(v.string()),
});

const tokenCountPayloadSchema = v.object({
	type: v.literal('token_count'),
	info: v.optional(recordSchema),
});

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

/**
 * Extract a model name from a token_count payload, walking five candidate
 * locations in precedence order: `info.model`, `info.model_name`,
 * `info.metadata.model`, top-level `payload.model`, `payload.metadata.model`.
 */
function extractModel(value: unknown): string | undefined {
	const parsed = v.safeParse(recordSchema, value);
	if (!parsed.success) {
		return undefined;
	}

	const payload = parsed.output;

	const infoCandidate = payload.info;
	if (infoCandidate != null) {
		const infoParsed = v.safeParse(recordSchema, infoCandidate);
		if (infoParsed.success) {
			const info = infoParsed.output;
			for (const candidate of [info.model, info.model_name]) {
				const model = asNonEmptyString(candidate);
				if (model != null) {
					return model;
				}
			}

			if (info.metadata != null) {
				const metadataParsed = v.safeParse(recordSchema, info.metadata);
				if (metadataParsed.success) {
					const model = asNonEmptyString(metadataParsed.output.model);
					if (model != null) {
						return model;
					}
				}
			}
		}
	}

	const fallbackModel = asNonEmptyString(payload.model);
	if (fallbackModel != null) {
		return fallbackModel;
	}

	if (payload.metadata != null) {
		const metadataParsed = v.safeParse(recordSchema, payload.metadata);
		if (metadataParsed.success) {
			const model = asNonEmptyString(metadataParsed.output.model);
			if (model != null) {
				return model;
			}
		}
	}

	return undefined;
}

/**
 * Resolve a Codex model name to one the shared pricing fetcher can price.
 * Applies the `gpt-5-codex -> gpt-5` alias; unknown names pass through
 * unchanged (the fetcher will warn and default to $0 if it cannot match).
 */
function resolveModelName(model: string): string {
	return CODEX_MODEL_ALIASES.get(model) ?? model;
}

/**
 * Get the Codex sessions directory path.
 *
 * Resolution order:
 * 1. `CODEX_HOME` env var (resolved relative to cwd)
 * 2. Sentinel `''` under VITEST (signals callers to skip the source)
 * 3. Default `~/.codex/sessions`
 *
 * Returns the default path even when it does not exist on disk; callers handle
 * missing directories gracefully.
 */
export function getCodexPath(): string {
	const envHome = process.env[CODEX_HOME_ENV]?.trim();
	if (envHome != null && envHome !== '') {
		return path.resolve(envHome, DEFAULT_CODEX_SESSIONS_SUBPATH);
	}

	if (process.env.VITEST != null) {
		return '';
	}

	return path.join(USER_HOME_DIR, DEFAULT_CODEX_HOME_PATH, DEFAULT_CODEX_SESSIONS_SUBPATH);
}

/**
 * Read and transform every Codex session JSONL under `codexPath` into the
 * shared {@link UsageData} shape. Missing directories or unreadable files are
 * logged at debug/warn level and skipped rather than thrown.
 *
 * @param codexPath - Absolute path to the Codex sessions directory
 * @param _options - Load options (currently unused, kept for parity with the
 *   other adapters so the loaders can call it uniformly)
 * @returns Transformed usage entries (one per `token_count` event delta)
 */
export async function processCodexSessions(
	codexPath: string,
	_options: LoadOptions = {},
): Promise<UsageData[]> {
	if (codexPath === '') {
		logger.debug('Codex sessions path is empty, skipping');
		return [];
	}

	const dirStat = await Result.try({
		try: async () => stat(codexPath),
		catch: error => error,
	})();
	if (Result.isFailure(dirStat) || !dirStat.value.isDirectory()) {
		logger.debug(`Codex sessions directory not found or not a directory: ${codexPath}`);
		return [];
	}

	const files = await glob(CODEX_SESSION_GLOB, {
		cwd: codexPath,
		absolute: true,
	});

	const results: UsageData[] = [];

	for (const file of files) {
		const relativeSessionPath = path.relative(codexPath, file);
		const normalizedSessionPath = relativeSessionPath.split(path.sep).join('/');
		const sessionId = normalizedSessionPath.replace(/\.jsonl$/i, '');

		const fileContentResult = await Result.try({
			try: async () => readFile(file, 'utf8'),
			catch: error => error,
		})();
		if (Result.isFailure(fileContentResult)) {
			logger.debug(`Failed to read Codex session file ${file}: ${String(fileContentResult.error)}`);
			continue;
		}

		let previousTotals: RawUsage | null = null;
		let currentModel: string | undefined;
		let currentModelIsFallback = false;
		const lines = fileContentResult.value.split(/\r?\n/);

		for (const [lineIndex, line] of lines.entries()) {
			const trimmed = line.trim();
			if (trimmed === '') {
				continue;
			}

			const parseLine = Result.try({
				try: () => JSON.parse(trimmed) as unknown,
				catch: error => error,
			})();
			if (Result.isFailure(parseLine)) {
				continue;
			}

			const entryParse = v.safeParse(entrySchema, parseLine.value);
			if (!entryParse.success) {
				continue;
			}

			const { type: entryType, payload, timestamp } = entryParse.output;

			if (entryType === 'turn_context') {
				const contextPayload = v.safeParse(recordSchema, payload ?? null);
				if (contextPayload.success) {
					const contextModel = extractModel(contextPayload.output);
					if (contextModel != null) {
						currentModel = contextModel;
						currentModelIsFallback = false;
					}
				}
				continue;
			}

			if (entryType !== 'event_msg') {
				continue;
			}

			const tokenPayloadResult = v.safeParse(tokenCountPayloadSchema, payload ?? undefined);
			if (!tokenPayloadResult.success) {
				continue;
			}

			if (timestamp == null) {
				continue;
			}

			const info = tokenPayloadResult.output.info;
			const lastUsage = normalizeRawUsage(info?.last_token_usage);
			const totalUsage = normalizeRawUsage(info?.total_token_usage);

			let raw = lastUsage;
			if (raw == null && totalUsage != null) {
				raw = subtractRawUsage(totalUsage, previousTotals);
			}

			if (totalUsage != null) {
				previousTotals = totalUsage;
			}

			if (raw == null) {
				continue;
			}

			// Skip zero deltas (e.g. heartbeat events with no new tokens).
			if (
				raw.input_tokens === 0
				&& raw.cached_input_tokens === 0
				&& raw.output_tokens === 0
				&& raw.reasoning_output_tokens === 0
			) {
				continue;
			}

			const payloadRecordResult = v.safeParse(recordSchema, payload ?? undefined);
			const extractionSource = payloadRecordResult.success
				? Object.assign({}, payloadRecordResult.output, { info })
				: { info };
			const extractedModel = extractModel(extractionSource);

			let model: string;
			if (extractedModel != null) {
				model = extractedModel;
				currentModel = extractedModel;
				currentModelIsFallback = false;
			}
			else if (currentModel != null) {
				model = currentModelIsFallback ? LEGACY_FALLBACK_MODEL : currentModel;
			}
			else {
				model = LEGACY_FALLBACK_MODEL;
				currentModel = model;
				currentModelIsFallback = true;
			}

			const usage = toClaudeUsage(raw);
			// Unique-per-event id so createUniqueHash does not collapse multiple
			// events from the same session. The line index disambiguates records
			// that share a timestamp (Codex can emit several token_count entries
			// with the same timestamp in a single turn).
			const uniqueId = `${sessionId}#${timestamp}#${lineIndex}`;

			const entry: UsageData = {
				timestamp: createISOTimestamp(timestamp),
				sessionId: createSessionId(sessionId),
				version: createVersion('1.0.0'),
				message: {
					usage,
					model: createModelName(resolveModelName(model)),
					id: createMessageId(uniqueId),
				},
				// Cost will be calculated by better-ccusage based on model pricing.
				requestId: createRequestId(uniqueId),
				cwd: path.join('codex', sessionId),
				source: createSource('codex'),
			};

			results.push(entry);
		}
	}

	logger.info(`Loaded ${results.length} Codex usage entries from ${codexPath}`);
	return results;
}

if (import.meta.vitest != null) {
	describe('processCodexSessions', () => {
		it('parses token_count events and derives deltas from cumulative totals', async () => {
			await using fixture = await createFixture({
				sessions: {
					'project-1.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-11T18:25:30.000Z',
							type: 'turn_context',
							payload: { model: 'gpt-5' },
						}),
						JSON.stringify({
							timestamp: '2025-09-11T18:25:40.670Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 1_200,
										cached_input_tokens: 200,
										output_tokens: 500,
										reasoning_output_tokens: 0,
										total_tokens: 1_700,
									},
									last_token_usage: {
										input_tokens: 1_200,
										cached_input_tokens: 200,
										output_tokens: 500,
										reasoning_output_tokens: 0,
										total_tokens: 1_700,
									},
									model: 'gpt-5',
								},
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-11T18:40:00.000Z',
							type: 'turn_context',
							payload: { model: 'gpt-5' },
						}),
						JSON.stringify({
							timestamp: '2025-09-12T00:00:00.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 2_000,
										cached_input_tokens: 300,
										output_tokens: 800,
										reasoning_output_tokens: 0,
										total_tokens: 2_800,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			const results = await processCodexSessions(fixture.getPath('sessions'));

			expect(results).toHaveLength(2);

			// First event uses last_token_usage directly. input_tokens excludes
			// the cached portion (1200 raw - 200 cached) so the additive cost
			// engine does not double-charge cached tokens.
			expect(results[0]!.message.model).toBe('gpt-5');
			expect(results[0]!.message.usage.input_tokens).toBe(1_000);
			expect(results[0]!.message.usage.cache_read_input_tokens).toBe(200);
			expect(results[0]!.message.usage.output_tokens).toBe(500);
			expect(results[0]!.source).toBe('codex');

			// Second event is a delta from the cumulative total (2000-1200, 300-200).
			// input = 800 raw - 100 cached = 700 billable at the input rate.
			expect(results[1]!.message.model).toBe('gpt-5');
			expect(results[1]!.message.usage.input_tokens).toBe(700);
			expect(results[1]!.message.usage.cache_read_input_tokens).toBe(100);
			expect(results[1]!.message.usage.output_tokens).toBe(300);
		});

		it('falls back to the legacy model when metadata is missing entirely', async () => {
			await using fixture = await createFixture({
				sessions: {
					'legacy.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-15T13:00:00.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 5_000,
										cached_input_tokens: 0,
										output_tokens: 1_000,
										reasoning_output_tokens: 0,
										total_tokens: 6_000,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			const results = await processCodexSessions(fixture.getPath('sessions'));

			expect(results).toHaveLength(1);
			expect(results[0]!.message.model).toBe(LEGACY_FALLBACK_MODEL);
		});

		it('aliases gpt-5-codex to gpt-5 so the pricing fetcher can price it', async () => {
			await using fixture = await createFixture({
				sessions: {
					'alias.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-16T10:00:00.000Z',
							type: 'turn_context',
							payload: { model: 'gpt-5-codex' },
						}),
						JSON.stringify({
							timestamp: '2025-09-16T10:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 100,
										cached_input_tokens: 10,
										output_tokens: 50,
										reasoning_output_tokens: 5,
										total_tokens: 150,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			const results = await processCodexSessions(fixture.getPath('sessions'));

			expect(results).toHaveLength(1);
			expect(results[0]!.message.model).toBe('gpt-5');
			// Reasoning tokens must not be added on top of output.
			expect(results[0]!.message.usage.output_tokens).toBe(50);
		});

		it('skips zero-delta events', async () => {
			await using fixture = await createFixture({
				sessions: {
					'zero.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-17T10:00:00.000Z',
							type: 'turn_context',
							payload: { model: 'gpt-5' },
						}),
						JSON.stringify({
							timestamp: '2025-09-17T10:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 0,
										cached_input_tokens: 0,
										output_tokens: 0,
										reasoning_output_tokens: 0,
										total_tokens: 0,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			const results = await processCodexSessions(fixture.getPath('sessions'));
			expect(results).toHaveLength(0);
		});
	});

	describe('getCodexPath', () => {
		it('returns empty string under VITEST when no env var is set', () => {
			const original = process.env.CODEX_HOME;
			delete process.env.CODEX_HOME;
			try {
				expect(getCodexPath()).toBe('');
			}
			finally {
				if (original !== undefined) {
					process.env.CODEX_HOME = original;
				}
			}
		});

		it('respects the CODEX_HOME env var', () => {
			const original = process.env.CODEX_HOME;
			process.env.CODEX_HOME = '/custom/codex';
			try {
				expect(getCodexPath()).toBe(path.resolve('/custom/codex', DEFAULT_CODEX_SESSIONS_SUBPATH));
			}
			finally {
				if (original === undefined) {
					delete process.env.CODEX_HOME;
				}
				else {
					process.env.CODEX_HOME = original;
				}
			}
		});
	});
}
