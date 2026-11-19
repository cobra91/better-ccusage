import type { LoadOptions, UsageData } from './data-loader.ts';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createFixture } from 'fs-fixture';
import { glob } from 'tinyglobby';
import {
	DEFAULT_GEMINI_TMP_PATH,
	GEMINI_DATA_DIR_ENV,
	GEMINI_LOG_GLOB,
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
 * Token counters extracted from a Gemini CLI log record.
 *
 * Gemini logs use many key aliases (`input`/`prompt`/`input_tokens`, …); the
 * first present alias wins. Fractional counts are truncated like upstream.
 */
type GeminiTokens = {
	input: number;
	output: number;
	cached: number;
	thoughts: number;
	tool: number;
	total: number | null;
};

const INPUT_KEYS = ['input', 'prompt', 'input_tokens', 'prompt_tokens'] as const;
const OUTPUT_KEYS = ['output', 'candidates', 'output_tokens', 'candidates_tokens'] as const;
const CACHED_KEYS = ['cached', 'cached_tokens'] as const;
const THOUGHTS_KEYS = ['thoughts', 'reasoning', 'thoughts_tokens', 'reasoning_tokens'] as const;
const TOOL_KEYS = ['tool', 'tool_tokens'] as const;

function tokenNumber(record: Record<string, unknown>, keys: readonly string[]): number {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'number' && Number.isFinite(value)) {
			return Math.max(0, Math.trunc(value));
		}
	}
	return 0;
}

function parseTokens(value: unknown): GeminiTokens | null {
	if (typeof value !== 'object' || value == null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const totalRaw = record.total ?? record.total_tokens;
	const total = typeof totalRaw === 'number' && Number.isFinite(totalRaw)
		? Math.max(0, Math.trunc(totalRaw))
		: null;
	return {
		input: tokenNumber(record, INPUT_KEYS),
		output: tokenNumber(record, OUTPUT_KEYS),
		cached: tokenNumber(record, CACHED_KEYS),
		thoughts: tokenNumber(record, THOUGHTS_KEYS),
		tool: tokenNumber(record, TOOL_KEYS),
		total,
	};
}

/**
 * Stats-style counters always overlap: `input` includes the cached share.
 */
function subtractCachedOverlap(tokens: GeminiTokens): { freshInput: number; cacheRead: number } {
	const cachedPortion = Math.min(tokens.input, tokens.cached);
	return { freshInput: tokens.input - cachedPortion, cacheRead: tokens.cached };
}

/**
 * Session-style counters are ambiguous: some Gemini CLI versions include the
 * cached share in `input`, others do not. The `total` field disambiguates —
 * when `total` equals the sum without `cached`, then `input` must already
 * contain the cached tokens (subtract them); otherwise keep `input` as-is.
 */
function normalizeSessionInput(tokens: GeminiTokens): { freshInput: number; cacheRead: number } {
	const inclusiveTotal = tokens.input + tokens.output + tokens.thoughts + tokens.tool;
	const exclusiveTotal = inclusiveTotal + tokens.cached;
	if (tokens.cached > 0 && tokens.total === inclusiveTotal && tokens.total !== exclusiveTotal) {
		return subtractCachedOverlap(tokens);
	}
	return { freshInput: tokens.input, cacheRead: tokens.cached };
}

function parseTimestampValue(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return value < 1e12 ? value * 1000 : value;
	}
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? null : parsed;
	}
	return null;
}

/**
 * Intermediate usage event shared by the JSON and JSONL record parsers.
 */
type GeminiUsageEvent = {
	timestamp: number;
	sessionId: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	messageId: string | null;
};

/**
 * Build a usage event from extracted tokens. Reasoning/thoughts tokens are
 * billed as output (Gemini bills thinking at the output rate, matching
 * upstream ccusage), so they are folded into `outputTokens` here.
 */
function buildEvent(
	model: string | null,
	sessionId: string,
	timestamp: number,
	tokens: GeminiTokens,
	normalizeInput: (tokens: GeminiTokens) => { freshInput: number; cacheRead: number },
	messageId: string | null,
): GeminiUsageEvent | null {
	if (model == null || model.trim() === '') {
		return null;
	}
	const { freshInput, cacheRead } = normalizeInput(tokens);
	const inputTokens = freshInput + tokens.tool;
	const outputTokens = tokens.output + tokens.thoughts;
	if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0) {
		return null;
	}
	return {
		timestamp,
		sessionId,
		model,
		inputTokens,
		outputTokens,
		cacheReadTokens: cacheRead,
		messageId,
	};
}

function eventFromRecord(
	record: Record<string, unknown>,
	modelHint: string | null,
	sessionId: string,
	fallbackTimestamp: number,
): GeminiUsageEvent | null {
	const tokens = parseTokens(record.tokens);
	if (tokens == null) {
		return null;
	}
	const timestamp = parseTimestampValue(record.timestamp)
		?? parseTimestampValue(record.created_at)
		?? fallbackTimestamp;
	return buildEvent(
		typeof record.model === 'string' && record.model.trim() !== '' ? record.model : modelHint,
		sessionId,
		timestamp,
		tokens,
		normalizeSessionInput,
		typeof record.id === 'string' && record.id !== '' ? record.id : null,
	);
}

/**
 * Stats blocks carry either a per-model breakdown (`stats.models.<model>.tokens`)
 * or flat counters. Both overlap styles subtract the cached share from input.
 */
function eventsFromStats(
	statsValue: unknown,
	modelHint: string | null,
	sessionId: string,
	timestamp: number,
): GeminiUsageEvent[] {
	if (typeof statsValue !== 'object' || statsValue == null) {
		return [];
	}
	const stats = statsValue as Record<string, unknown>;
	const models = stats.models;
	if (typeof models === 'object' && models != null) {
		const events: GeminiUsageEvent[] = [];
		for (const [model, data] of Object.entries(models as Record<string, unknown>)) {
			if (typeof data !== 'object' || data == null) {
				continue;
			}
			const tokens = parseTokens((data as Record<string, unknown>).tokens);
			if (tokens == null) {
				continue;
			}
			const event = buildEvent(model, sessionId, timestamp, tokens, subtractCachedOverlap, null);
			if (event != null) {
				events.push(event);
			}
		}
		if (events.length > 0) {
			return events;
		}
	}
	const tokens = parseTokens(stats);
	const event = tokens == null ? null : buildEvent(modelHint, sessionId, timestamp, tokens, subtractCachedOverlap, null);
	return event == null ? [] : [event];
}

/** Whether a record carries a `stats`/`result.stats` block with token counts. */
function statsValueOf(record: Record<string, unknown>): unknown {
	const stats = record.stats;
	if (stats != null) {
		return stats;
	}
	const result = record.result;
	if (typeof result === 'object' && result != null) {
		return (result as Record<string, unknown>).stats ?? null;
	}
	return null;
}

async function fileModifiedTimestamp(filePath: string): Promise<number> {
	try {
		return (await stat(filePath)).mtimeMs;
	}
	catch {
		return 0;
	}
}

/**
 * Parse a whole-file JSON chat session document
 * (`chats/session-*.json`: `{sessionId, startTime, lastUpdated, messages[]}`).
 */
async function parseJsonDocFile(filePath: string): Promise<GeminiUsageEvent[]> {
	const fallbackTimestamp = await fileModifiedTimestamp(filePath);
	let document: unknown;
	try {
		document = JSON.parse(await readFile(filePath, 'utf-8'));
	}
	catch {
		return [];
	}
	if (typeof document !== 'object' || document == null) {
		return [];
	}
	const record = document as Record<string, unknown>;
	const sessionId = sessionIdOf(record) ?? path.basename(filePath, path.extname(filePath));
	const sessionTimestamp = parseTimestampValue(record.startTime)
		?? parseTimestampValue(record.lastUpdated)
		?? fallbackTimestamp;
	const messages = record.messages;
	if (Array.isArray(messages)) {
		const events: GeminiUsageEvent[] = [];
		for (const message of messages) {
			if (typeof message !== 'object' || message == null) {
				continue;
			}
			const entry = message as Record<string, unknown>;
			if (entry.type !== 'gemini') {
				continue;
			}
			const event = eventFromRecord(entry, null, sessionId, sessionTimestamp);
			if (event != null) {
				events.push(event);
			}
		}
		return events;
	}
	if (record.type === 'gemini') {
		const event = eventFromRecord(record, null, sessionId, fallbackTimestamp);
		return event == null ? [] : [event];
	}
	return eventsFromStats(statsValueOf(record), modelOf(record), sessionId, parseTimestampValue(record.timestamp) ?? fallbackTimestamp);
}

function sessionIdOf(record: Record<string, unknown>): string | null {
	const value = record.sessionId ?? record.session_id;
	return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function modelOf(record: Record<string, unknown>): string | null {
	const value = record.model;
	return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Parse a JSONL log file. Envelope lines update the session id / current
 * model; `type: "gemini"` lines are usage events (deduped by id — a later
 * record with the same id replaces the earlier one); `stats` lines carry
 * aggregated counters.
 */
async function parseJsonlFile(filePath: string): Promise<GeminiUsageEvent[]> {
	const fallbackTimestamp = await fileModifiedTimestamp(filePath);
	let sessionId = path.basename(filePath, path.extname(filePath));
	let currentModel: string | null = null;
	const events: GeminiUsageEvent[] = [];
	const directEventIndexes = new Map<string, number>();
	let content: string;
	try {
		content = await readFile(filePath, 'utf-8');
	}
	catch {
		return [];
	}
	for (const line of content.split(/\r?\n/)) {
		if (line.trim() === '') {
			continue;
		}
		let record: unknown;
		try {
			record = JSON.parse(line);
		}
		catch {
			continue;
		}
		if (typeof record !== 'object' || record == null) {
			continue;
		}
		const entry = record as Record<string, unknown>;
		sessionId = sessionIdOf(entry) ?? sessionId;
		currentModel = modelOf(entry) ?? currentModel;
		if (entry.type === 'gemini') {
			const event = eventFromRecord(entry, currentModel, sessionId, fallbackTimestamp);
			if (event == null) {
				continue;
			}
			if (event.messageId != null) {
				const existing = directEventIndexes.get(event.messageId);
				if (existing !== undefined) {
					events[existing] = event;
				}
				else {
					directEventIndexes.set(event.messageId, events.length);
					events.push(event);
				}
			}
			else {
				events.push(event);
			}
			continue;
		}
		const stats = statsValueOf(entry);
		if (stats != null) {
			events.push(
				...eventsFromStats(stats, currentModel, sessionId, parseTimestampValue(entry.timestamp) ?? fallbackTimestamp),
			);
		}
	}
	return events;
}

/**
 * Resolve the Gemini CLI log directories.
 *
 * Honors the `GEMINI_DATA_DIR` environment variable (comma-separated list,
 * resolved against the working directory when relative), otherwise falls back
 * to `~/.gemini/tmp`.
 */
export function getGeminiPaths(): string[] {
	const envDir = process.env[GEMINI_DATA_DIR_ENV]?.trim();
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

	const candidate = path.join(USER_HOME_DIR, DEFAULT_GEMINI_TMP_PATH);
	return existsSync(candidate) ? [candidate] : [];
}

/**
 * Read all Gemini CLI log files under the given roots and transform them into
 * {@link UsageData} entries. JSONL session logs and whole-file chat session
 * documents are both accepted; files without usage data are skipped.
 */
export async function processGeminiSessions(dataDirs: string[], _options: LoadOptions = {}): Promise<UsageData[]> {
	if (dataDirs.length === 0 || (dataDirs.length === 1 && dataDirs[0] === '')) {
		logger.debug('Gemini data directories are empty, skipping');
		return [];
	}

	const files = await glob([...GEMINI_LOG_GLOB], { cwd: dataDirs[0], absolute: true, onlyFiles: true });
	for (const dir of dataDirs.slice(1)) {
		files.push(...await glob([...GEMINI_LOG_GLOB], { cwd: dir, absolute: true, onlyFiles: true }));
	}
	files.sort();

	const events: GeminiUsageEvent[] = [];
	for (const file of files) {
		try {
			const parsed = file.endsWith('.jsonl')
				? await parseJsonlFile(file)
				: await parseJsonDocFile(file);
			events.push(...parsed);
		}
		catch (error) {
			logger.warn(`Failed to parse Gemini log ${file}: ${String(error)}`);
		}
	}
	events.sort((a, b) => a.timestamp - b.timestamp);

	const results: UsageData[] = events.map((event, index) => {
		const messageId = event.messageId ?? `${event.sessionId}:${event.timestamp}:${index}`;
		return {
			timestamp: createISOTimestamp(new Date(event.timestamp).toISOString()),
			sessionId: createSessionId(event.sessionId),
			version: createVersion('1.0.0'),
			message: {
				usage: {
					input_tokens: event.inputTokens,
					output_tokens: event.outputTokens,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: event.cacheReadTokens,
				},
				model: createModelName(event.model),
				id: createMessageId(messageId),
			},
			requestId: createRequestId(messageId),
			cwd: path.join('gemini', 'unknown'),
			source: createSource('gemini'),
		} satisfies UsageData;
	});

	if (results.length > 0) {
		logger.info(`Loaded ${results.length} Gemini CLI usage entries from ${dataDirs.join(', ')}`);
	}
	return results;
}

if (import.meta.vitest != null) {
	describe('processGeminiSessions', () => {
		it('parses JSONL token events and separates cached input', async () => {
			await using fixture = await createFixture({
				'project/chats/session-a.jsonl': [
					JSON.stringify({ sessionId: 'session-a', projectHash: 'project-a', startTime: '2026-05-17T11:07:00.000Z' }),
					JSON.stringify({
						id: 'msg-a',
						timestamp: '2026-05-17T11:07:32.000Z',
						type: 'gemini',
						model: 'gemini-3-flash-preview',
						tokens: { input: 15327, output: 23, cached: 11526, thoughts: 919, tool: 7, total: 16276 },
					}),
				].join('\n'),
			});

			const results = await processGeminiSessions([fixture.path]);

			expect(results).toHaveLength(1);
			const usage = results[0]!.message.usage;
			expect(results[0]!.source).toBe('gemini');
			expect(results[0]!.sessionId).toBe('session-a');
			expect(results[0]!.message.model).toBe('gemini-3-flash-preview');
			// input includes the cached share (total == sum-without-cached), so
			// fresh input is 15327 - 11526 = 3801, plus 7 tool tokens.
			expect(usage.input_tokens).toBe(3808);
			// Thoughts are billed as output: 23 + 919.
			expect(usage.output_tokens).toBe(942);
			expect(usage.cache_read_input_tokens).toBe(11526);
		});

		it('parses whole-file chat session documents with messages array', async () => {
			await using fixture = await createFixture({
				'chats/session-b.json': JSON.stringify({
					sessionId: 'session-b',
					startTime: '2026-03-16T14:21:45.000Z',
					lastUpdated: '2026-03-16T14:22:00.000Z',
					messages: [
						{ id: 'u1', timestamp: '2026-03-16T14:21:45.945Z', type: 'user', content: [] },
						{
							id: 'g1',
							timestamp: '2026-03-16T14:21:55.515Z',
							type: 'gemini',
							model: 'gemini-3-flash-preview',
							tokens: { input: 8608, output: 30, cached: 0, thoughts: 89, tool: 0, total: 8727 },
						},
					],
				}),
			});

			const results = await processGeminiSessions([fixture.path]);

			expect(results).toHaveLength(1);
			const usage = results[0]!.message.usage;
			expect(usage.input_tokens).toBe(8608);
			expect(usage.output_tokens).toBe(119);
			expect(usage.cache_read_input_tokens).toBe(0);
			expect(results[0]!.message.id).toBe('g1');
		});

		it('parses stats blocks with per-model breakdown (overlapping input)', async () => {
			await using fixture = await createFixture({
				'logs.jsonl': [
					JSON.stringify({
						timestamp: '2026-05-18T10:00:00.000Z',
						stats: {
							models: {
								'gemini-3-pro-preview': { tokens: { input: 5000, output: 40, cached: 4000, total: 9040 } },
							},
						},
					}),
				].join('\n'),
			});

			const results = await processGeminiSessions([fixture.path]);

			expect(results).toHaveLength(1);
			const usage = results[0]!.message.usage;
			expect(results[0]!.message.model).toBe('gemini-3-pro-preview');
			// Stats input always overlaps: fresh = 5000 - 4000.
			expect(usage.input_tokens).toBe(1000);
			expect(usage.output_tokens).toBe(40);
			expect(usage.cache_read_input_tokens).toBe(4000);
		});

		it('deduplicates JSONL events sharing an id (later record wins)', async () => {
			await using fixture = await createFixture({
				'dup.jsonl': [
					JSON.stringify({ type: 'gemini', id: 'm1', timestamp: '2026-05-19T10:00:00.000Z', model: 'gemini-3-flash-preview', tokens: { input: 100, output: 5 } }),
					JSON.stringify({ type: 'gemini', id: 'm1', timestamp: '2026-05-19T10:00:01.000Z', model: 'gemini-3-flash-preview', tokens: { input: 200, output: 10 } }),
				].join('\n'),
			});

			const results = await processGeminiSessions([fixture.path]);

			expect(results).toHaveLength(1);
			expect(results[0]!.message.usage.input_tokens).toBe(200);
		});

		it('returns empty for roots without usage data', async () => {
			await using fixture = await createFixture({
				'readme.txt': 'nope',
				'empty.json': JSON.stringify({ sessionId: 'x', messages: [] }),
			});

			const results = await processGeminiSessions([fixture.path]);

			expect(results).toHaveLength(0);
		});
	});
}
