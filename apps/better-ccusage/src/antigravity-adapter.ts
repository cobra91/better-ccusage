import type { LoadOptions, UsageData } from './data-loader.ts';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createFixture } from 'fs-fixture';
import { glob } from 'tinyglobby';
import {
	ANTIGRAVITY_CONVERSATIONS_DIR,
	ANTIGRAVITY_DATA_DIR_ENV,
	DEFAULT_ANTIGRAVITY_ROOT_PATHS,
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
 * Antigravity stores each conversation in a SQLite database whose
 * `gen_metadata` / `steps` rows embed protobuf blobs. The wire schema was
 * reverse-engineered by upstream ccusage (rust/adapters/antigravity); the
 * field numbers below mirror it so both tools agree on the numbers.
 *
 * Token semantics: `input_tokens` is fresh input (the cached shares live in
 * their own counters), `total_output_tokens` includes reasoning tokens —
 * which are billed at the output rate, so they are folded into the emitted
 * `output_tokens`.
 */

type ProtoValue = { kind: 'varint'; value: number } | { kind: 'bytes'; value: Uint8Array } | { kind: 'fixed' };
type ProtoField = { number: number; value: ProtoValue };

const textDecoder = new TextDecoder('utf-8');

function readVarint(blob: Uint8Array, offset: number): { value: number; next: number } | null {
	let result = 0;
	let shift = 0;
	let cursor = offset;
	for (let guard = 0; guard < 10; guard++) {
		if (cursor >= blob.length) {
			return null;
		}
		const byte = blob[cursor]!;
		cursor++;
		result += (byte & 0x7F) * 2 ** shift;
		if ((byte & 0x80) === 0) {
			return { value: result, next: cursor };
		}
		shift += 7;
	}
	return null;
}

/** Decode one protobuf message into its top-level fields (wire types 0/1/2/5). */
function decodeFields(blob: Uint8Array): ProtoField[] | null {
	const fields: ProtoField[] = [];
	let offset = 0;
	while (offset < blob.length) {
		const tag = readVarint(blob, offset);
		if (tag == null) {
			return null;
		}
		offset = tag.next;
		const number = Math.floor(tag.value / 8);
		const wire = tag.value % 8;
		if (number === 0) {
			return null;
		}
		if (wire === 0) {
			const value = readVarint(blob, offset);
			if (value == null) {
				return null;
			}
			offset = value.next;
			fields.push({ number, value: { kind: 'varint', value: value.value } });
		}
		else if (wire === 2) {
			const length = readVarint(blob, offset);
			if (length == null) {
				return null;
			}
			// readVarint's cursor starts at `offset`, so `next` is absolute.
			const start = length.next;
			if (start + length.value > blob.length) {
				return null;
			}
			fields.push({ number, value: { kind: 'bytes', value: blob.subarray(start, start + length.value) } });
			offset = start + length.value;
		}
		else if (wire === 1) {
			if (offset + 8 > blob.length) {
				return null;
			}
			fields.push({ number, value: { kind: 'fixed' } });
			offset += 8;
		}
		else if (wire === 5) {
			if (offset + 4 > blob.length) {
				return null;
			}
			fields.push({ number, value: { kind: 'fixed' } });
			offset += 4;
		}
		else {
			return null;
		}
	}
	return fields;
}

function fieldVarint(fields: ProtoField[], number: number): number | null {
	for (let i = fields.length - 1; i >= 0; i--) {
		const field = fields[i]!;
		if (field.number === number && field.value.kind === 'varint') {
			return field.value.value;
		}
	}
	return null;
}

function fieldBytes(fields: ProtoField[], number: number): Uint8Array | null {
	for (const field of fields) {
		if (field.number === number && field.value.kind === 'bytes') {
			return field.value.value;
		}
	}
	return null;
}

function fieldBytesAll(fields: ProtoField[], number: number): Uint8Array[] {
	const values: Uint8Array[] = [];
	for (const field of fields) {
		if (field.number === number && field.value.kind === 'bytes') {
			values.push(field.value.value);
		}
	}
	return values;
}

function fieldText(fields: ProtoField[], number: number): string | null {
	const value = fieldBytes(fields, number);
	if (value == null) {
		return null;
	}
	const text = textDecoder.decode(value);
	return text.trim() === '' ? null : text;
}

/** Map a nullable varint to null when absent or zero (0 means "unset" here). */
function nonZeroOrNull(value: number | null): number | null {
	return value != null && value !== 0 ? value : null;
}

function decodeMessage(blob: Uint8Array): ProtoField[] | null {
	return decodeFields(blob);
}

/** Protobuf `Timestamp { seconds, nanos }` → epoch milliseconds. */
function parseTimestampMessage(blob: Uint8Array): number | null {
	const fields = decodeMessage(blob);
	if (fields == null) {
		return null;
	}
	const seconds = fieldVarint(fields, 1);
	if (seconds == null || seconds <= 0) {
		return null;
	}
	const nanos = Math.min(fieldVarint(fields, 2) ?? 0, 999_999_999);
	const milliseconds = seconds * 1000 + Math.floor(nanos / 1_000_000);
	// Damaged rows can carry values outside JavaScript's date range; treat
	// those as absent so the timestamp fallback chain still applies.
	return Number.isSafeInteger(milliseconds) && Math.abs(milliseconds) <= 8.64e15 ? milliseconds : null;
}

type ModelUsage = {
	modelId: number | null;
	inputTokens: number;
	totalOutputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	reasoningTokens: number;
	visibleOutputTokens: number;
	messageId: string | null;
	responseId: string | null;
	providerAssignedMessageId: string | null;
};

function parseModelUsage(blob: Uint8Array): ModelUsage | null {
	const fields = decodeMessage(blob);
	if (fields == null) {
		return null;
	}
	return {
		modelId: nonZeroOrNull(fieldVarint(fields, 1)),
		inputTokens: fieldVarint(fields, 2) ?? 0,
		totalOutputTokens: fieldVarint(fields, 3) ?? 0,
		cacheCreationTokens: fieldVarint(fields, 4) ?? 0,
		cacheReadTokens: fieldVarint(fields, 5) ?? 0,
		reasoningTokens: fieldVarint(fields, 9) ?? 0,
		visibleOutputTokens: fieldVarint(fields, 10) ?? 0,
		messageId: fieldText(fields, 7),
		responseId: fieldText(fields, 11),
		providerAssignedMessageId: fieldText(fields, 12),
	};
}

function isTokenBearing(usage: ModelUsage): boolean {
	return usage.inputTokens > 0
		|| usage.totalOutputTokens > 0
		|| usage.cacheCreationTokens > 0
		|| usage.cacheReadTokens > 0
		|| usage.reasoningTokens > 0
		|| usage.visibleOutputTokens > 0;
}

function identityKeys(usage: ModelUsage): string[] {
	const keys: string[] = [];
	if (usage.responseId != null) {
		keys.push(`response:${usage.responseId}`);
	}
	if (usage.providerAssignedMessageId != null) {
		keys.push(`provider:${usage.providerAssignedMessageId}`);
	}
	if (usage.messageId != null) {
		keys.push(`message:${usage.messageId}`);
	}
	return keys;
}

function sameTokenCounts(a: ModelUsage, b: ModelUsage): boolean {
	return a.inputTokens === b.inputTokens
		&& a.totalOutputTokens === b.totalOutputTokens
		&& a.cacheCreationTokens === b.cacheCreationTokens
		&& a.cacheReadTokens === b.cacheReadTokens
		&& a.reasoningTokens === b.reasoningTokens
		&& a.visibleOutputTokens === b.visibleOutputTokens;
}

/** Whether `retry` is the primary usage mirrored inside a retry_infos list. */
function isMirrorOf(retry: ModelUsage, primary: ModelUsage): boolean {
	return sameTokenCounts(retry, primary)
		&& identityKeys(retry).every(identity => identityKeys(primary).includes(identity));
}

/** Preferred message id for dedup: response id > provider id > message id. */
function preferredMessageId(usage: ModelUsage): { id: string | null; rank: number } {
	if (usage.responseId != null) {
		return { id: usage.responseId, rank: 3 };
	}
	if (usage.providerAssignedMessageId != null) {
		return { id: usage.providerAssignedMessageId, rank: 2 };
	}
	if (usage.messageId != null) {
		return { id: usage.messageId, rank: 1 };
	}
	return { id: null, rank: 0 };
}

const DEFAULT_MODEL = 'gemini-internal-model';
const UNRESOLVED_PLACEHOLDER_PREFIX = 'model_placeholder_m';
const UNRESOLVED_ID_PREFIX = 'antigravity-model-';

/** Numeric Antigravity model ids → canonical names (mirrors upstream). */
const MODEL_NAME_BY_ID = new Map<number, string>([
	[246, 'gemini-2.5-pro'],
	[312, 'gemini-2.5-flash'],
	[313, 'gemini-2.5-flash-thinking'],
	[329, 'gemini-2.5-flash-thinking'],
	[330, 'gemini-2.5-flash-lite'],
	[281, 'claude-4-sonnet'],
	[282, 'claude-4-sonnet'],
	[290, 'claude-4-opus'],
	[291, 'claude-4-opus'],
	[333, 'claude-4.5-sonnet'],
	[334, 'claude-4.5-sonnet'],
	[340, 'claude-4.5-haiku'],
	[341, 'claude-4.5-haiku'],
	[342, 'gpt-oss-120b-medium'],
	[1318, 'gemini-3.8-flash-high'],
	[1319, 'gemini-3.8-flash-medium'],
	[1320, 'gemini-3.8-flash-low'],
	[1298, 'gemini-3.7-flash-high'],
	[1299, 'gemini-3.7-flash-medium'],
	[1300, 'gemini-3.7-flash-low'],
	[1071, 'gemini-3.6-flash-high'],
	[1072, 'gemini-3.6-flash-medium'],
	[1073, 'gemini-3.6-flash-low'],
	[1417, 'gemini-4-argon'],
	[1418, 'gemini-4-argon'],
	[1419, 'gemini-4-argon'],
	[1402, 'claude-opus-5-5'],
	[1050, 'gemini-3.1-flash-lite'],
]);

function modelNameFromId(modelId: number): string {
	if (modelId >= 1000) {
		return `${UNRESOLVED_PLACEHOLDER_PREFIX}${modelId - 1000}`;
	}
	return MODEL_NAME_BY_ID.get(modelId) ?? `${UNRESOLVED_ID_PREFIX}${modelId}`;
}

/** Placeholder names like `model_placeholder_m318` → canonical model. */
const PLACEHOLDER_NAMES = new Map<string, string>([
	['model_placeholder_m318', 'gemini-3.8-flash-high'],
	['model_placeholder_m319', 'gemini-3.8-flash-medium'],
	['model_placeholder_m320', 'gemini-3.8-flash-low'],
	['model_placeholder_m298', 'gemini-3.7-flash-high'],
	['model_placeholder_m299', 'gemini-3.7-flash-medium'],
	['model_placeholder_m300', 'gemini-3.7-flash-low'],
	['model_placeholder_m71', 'gemini-3.6-flash-high'],
	['model_placeholder_m72', 'gemini-3.6-flash-medium'],
	['model_placeholder_m73', 'gemini-3.6-flash-low'],
	['model_placeholder_m417', 'gemini-4-argon'],
	['model_placeholder_m418', 'gemini-4-argon'],
	['model_placeholder_m419', 'gemini-4-argon'],
	['model_placeholder_m402', 'claude-opus-5-5'],
	['model_placeholder_m50', 'gemini-3.1-flash-lite'],
	['model_placeholder_m26', 'claude-opus-4-6'],
	['model_placeholder_m35', 'claude-sonnet-4-6'],
	['model_placeholder_m36', 'gemini-3.1-pro'],
	['model_placeholder_m37', 'gemini-3.1-pro'],
	['model_placeholder_m16', 'gemini-3.1-pro'],
	['model_placeholder_m18', 'gemini-3-flash-preview'],
	['model_placeholder_m84', 'gemini-3-flash-preview'],
	['model_placeholder_m47', 'gemini-3-flash-preview'],
	['model_placeholder_m132', 'gemini-3.5-flash-high'],
	['model_placeholder_m133', 'gemini-3.5-flash-high'],
	['model_placeholder_m187', 'gemini-3.5-flash-extra-low'],
	['model_placeholder_m20', 'gemini-3.5-flash-medium'],
	['model_openai_gpt_oss_120b_medium', 'gpt-oss-120b-medium'],
	['gemini-pro-default', 'gemini-3.1-pro'],
	['gemini-pro-agent', 'gemini-3.1-pro'],
	['gemini-3-flash-agent', 'gemini-3.5-flash-high'],
	['gemini-3-flash-agent-a', 'gemini-3.5-flash-high'],
	['gemini-3-flash-agent-b', 'gemini-3.5-flash-high'],
	['gemini-3-flash-a', 'gemini-3.5-flash-high'],
	['gemini-3-flash-b', 'gemini-3.5-flash-high'],
	['gemini-3-flash-c', 'gemini-3-flash-preview'],
	['gemini-3-flash', 'gemini-3-flash-preview'],
	['gemini-3.5-flash-low', 'gemini-3.5-flash-medium'],
	['gemini-3.1-pro-high', 'gemini-3.1-pro'],
	['gemini-3.1-pro-low', 'gemini-3.1-pro'],
	['gemini-3-pro-high', 'gemini-3-pro'],
	['gemini-3-pro-low', 'gemini-3-pro'],
	['gemini 3.8 flash (high)', 'gemini-3.8-flash-high'],
	['gemini 3.8 flash (medium)', 'gemini-3.8-flash-medium'],
	['gemini 3.8 flash (low)', 'gemini-3.8-flash-low'],
	['gemini 3.7 flash (high)', 'gemini-3.7-flash-high'],
	['gemini 3.7 flash (medium)', 'gemini-3.7-flash-medium'],
	['gemini 3.7 flash (low)', 'gemini-3.7-flash-low'],
	['gemini 3.6 flash (high)', 'gemini-3.6-flash-high'],
	['gemini 3.6 flash (medium)', 'gemini-3.6-flash-medium'],
	['gemini 3.6 flash (low)', 'gemini-3.6-flash-low'],
	['gemini 3.8 flash', 'gemini-3.8-flash'],
	['gemini 3.8 flash thinking', 'gemini-3.8-flash'],
	['gemini 3.7 flash', 'gemini-3.7-flash'],
	['gemini 3.7 flash thinking', 'gemini-3.7-flash'],
	['gemini 3.7 pro', 'gemini-3.7-pro'],
	['gemini 3.7 pro thinking', 'gemini-3.7-pro'],
	['gemini 3.6 flash', 'gemini-3.6-flash'],
	['gemini 3 flash', 'gemini-3.6-flash'],
	['gemini 3.6 pro', 'gemini-3.6-pro'],
	['gemini 3 pro', 'gemini-3-pro'],
	['gemini 3 pro thinking', 'gemini-3-pro'],
	['gemini 2.5 flash', 'gemini-2.5-flash'],
	['gemini 2.5 pro', 'gemini-2.5-pro'],
	['gemini 2.0 flash', 'gemini-2.0-flash'],
	['gemini 2 flash', 'gemini-2.0-flash'],
	['gemini 2.0 pro', 'gemini-2.0-pro'],
	['gemini 1.5 flash', 'gemini-1.5-flash'],
	['gemini 1.5 pro', 'gemini-1.5-pro'],
	['claude 3.7 sonnet', 'claude-3-7-sonnet'],
	['claude 3.7 sonnet thinking', 'claude-3-7-sonnet'],
	['claude 3.5 sonnet', 'claude-3-5-sonnet'],
	['claude 3.5 haiku', 'claude-3-5-haiku'],
	['claude 3 opus', 'claude-3-opus'],
]);

type ModelResolution = 0 | 1 | 2; // 0 = default, 1 = placeholder, 2 = resolved

function modelResolution(model: string): ModelResolution {
	if (model === DEFAULT_MODEL) {
		return 0;
	}
	if (model.startsWith(UNRESOLVED_PLACEHOLDER_PREFIX) || model.startsWith(UNRESOLVED_ID_PREFIX)) {
		return 1;
	}
	return 2;
}

/**
 * Normalize a raw Antigravity model label (display names with spaces/effort
 * variants, placeholder ids) to a canonical model name.
 */
function normalizeAntigravityModel(raw: string | null | undefined): string | null {
	if (raw == null) {
		return null;
	}
	const trimmed = raw.trim();
	if (trimmed === '') {
		return null;
	}
	const lower = trimmed.toLowerCase();
	const mapped = PLACEHOLDER_NAMES.get(lower);
	if (mapped != null) {
		return mapped;
	}
	const base = lower.includes('(') ? lower.slice(0, lower.indexOf('(')).trim() : lower;
	const baseMapped = PLACEHOLDER_NAMES.get(base);
	if (baseMapped != null) {
		return baseMapped;
	}
	const converted = base.replaceAll(' ', '-');
	if (converted.startsWith('gemini-') || converted.startsWith('claude-') || converted.startsWith('gpt-')) {
		return converted;
	}
	return trimmed;
}

function resolvedModelNameFromId(modelId: number | null): string | null {
	if (modelId == null) {
		return null;
	}
	return normalizeAntigravityModel(modelNameFromId(modelId));
}

type GeneratorMetadata = {
	model: string | null;
	modelId: number | null;
	usage: ModelUsage | null;
	retryUsages: ModelUsage[];
	timestamp: number | null;
	stepIndices: number[];
};

function parseGeneratorMetadata(blob: Uint8Array): GeneratorMetadata | null {
	const root = decodeMessage(blob);
	if (root == null) {
		return null;
	}
	const chatModelBytes = fieldBytes(root, 1);
	if (chatModelBytes == null) {
		return null;
	}
	const chatModel = decodeMessage(chatModelBytes);
	if (chatModel == null) {
		return null;
	}
	const usageBytes = fieldBytes(chatModel, 4);
	const usage = usageBytes == null ? null : parseModelUsage(usageBytes);
	const retryUsages: ModelUsage[] = [];
	for (const retryBytes of fieldBytesAll(chatModel, 17)) {
		const retryFields = decodeMessage(retryBytes);
		if (retryFields == null) {
			continue;
		}
		const retryUsageBytes = fieldBytes(retryFields, 2);
		if (retryUsageBytes == null) {
			continue;
		}
		const retryUsage = parseModelUsage(retryUsageBytes);
		if (retryUsage != null) {
			retryUsages.push(retryUsage);
		}
	}
	// retry_infos lists every attempt including a possible mirror of the
	// primary usage — drop at most one mirror.
	if (usage != null) {
		const mirrorIndex = retryUsages.findIndex(retry => isMirrorOf(retry, usage));
		if (mirrorIndex >= 0) {
			retryUsages.splice(mirrorIndex, 1);
		}
	}
	let timestamp: number | null = null;
	const generationInfoBytes = fieldBytes(chatModel, 9);
	if (generationInfoBytes != null) {
		const generationInfo = decodeMessage(generationInfoBytes);
		if (generationInfo != null) {
			const timestampBytes = fieldBytes(generationInfo, 4);
			if (timestampBytes != null) {
				timestamp = parseTimestampMessage(timestampBytes);
			}
		}
	}
	const model = fieldText(chatModel, 19) ?? fieldText(chatModel, 21);
	const modelId = nonZeroOrNull(fieldVarint(chatModel, 3));
	const stepIndices: number[] = [];
	for (const field of root) {
		if (field.number !== 2) {
			continue;
		}
		if (field.value.kind === 'varint') {
			stepIndices.push(field.value.value);
		}
		else if (field.value.kind === 'bytes') {
			let offset = 0;
			for (;;) {
				const value = readVarint(field.value.value, offset);
				if (value == null) {
					break;
				}
				offset = value.next;
				stepIndices.push(value.value);
			}
		}
	}
	return { model, modelId, usage, retryUsages, timestamp, stepIndices };
}

type StepMetadata = {
	model: string | null;
	modelId: number | null;
	usage: ModelUsage | null;
	retryUsages: ModelUsage[];
	timestamp: number | null;
};

function parseStepMetadata(blob: Uint8Array): StepMetadata | null {
	const fields = decodeMessage(blob);
	if (fields == null) {
		return null;
	}
	const usageBytes = fieldBytes(fields, 9);
	const usage = usageBytes == null ? null : parseModelUsage(usageBytes);
	const retryUsages: ModelUsage[] = [];
	for (const retryBytes of fieldBytesAll(fields, 28)) {
		const retryFields = decodeMessage(retryBytes);
		if (retryFields == null) {
			continue;
		}
		const retryUsageBytes = fieldBytes(retryFields, 2);
		if (retryUsageBytes == null) {
			continue;
		}
		const retryUsage = parseModelUsage(retryUsageBytes);
		if (retryUsage != null) {
			retryUsages.push(retryUsage);
		}
	}
	if (usage != null) {
		const mirrorIndex = retryUsages.findIndex(retry => isMirrorOf(retry, usage));
		if (mirrorIndex >= 0) {
			retryUsages.splice(mirrorIndex, 1);
		}
	}
	let model: string | null = null;
	let modelId: number | null = null;
	const modelInfoBytes = fieldBytes(fields, 24);
	if (modelInfoBytes != null) {
		const modelInfo = decodeMessage(modelInfoBytes);
		if (modelInfo != null) {
			model = fieldText(modelInfo, 12) ?? fieldText(modelInfo, 8);
			modelId = nonZeroOrNull(fieldVarint(modelInfo, 1));
		}
	}
	let timestamp: number | null = null;
	const timestampBytes = fieldBytes(fields, 8) ?? fieldBytes(fields, 1);
	if (timestampBytes != null) {
		timestamp = parseTimestampMessage(timestampBytes);
	}
	return { model, modelId, usage, retryUsages, timestamp };
}

/** One billable usage event, before cross-database deduplication. */
type AntigravityUsageEvent = {
	timestamp: number;
	timestampRank: number;
	sessionId: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	reasoningTokens: number;
	totalOutputTokens: number;
	messageId: string | null;
	messageIdRank: number;
	identities: string[];
};

type EventContext = {
	model: string | null;
	modelId: number | null;
	timestamp: number | null;
	trajectoryTimestamp: number | null;
	fallbackTimestamp: number;
	sessionId: string;
	fallbackIdentities: string[];
};

function appendUsageEvent(
	events: AntigravityUsageEvent[],
	identityTimestamps: Map<string, { timestamp: number; rank: number }>,
	usage: ModelUsage,
	context: EventContext,
): void {
	if (!isTokenBearing(usage)) {
		return;
	}
	let identities = identityKeys(usage);
	if (identities.length === 0) {
		identities = [...context.fallbackIdentities];
	}
	const identityTimestamp = identities
		.map(identity => identityTimestamps.get(identity))
		.find(entry => entry != null);
	const resolved = context.timestamp != null
		? { timestamp: context.timestamp, rank: 3 }
		: identityTimestamp != null
			? identityTimestamp
			: context.trajectoryTimestamp != null
				? { timestamp: context.trajectoryTimestamp, rank: 1 }
				: { timestamp: context.fallbackTimestamp, rank: 0 };
	const totalOutputTokens = Math.max(
		usage.totalOutputTokens,
		usage.visibleOutputTokens + usage.reasoningTokens,
	);
	const outputTokens = Math.max(usage.visibleOutputTokens, totalOutputTokens - usage.reasoningTokens);
	const reasoningTokens = Math.max(usage.reasoningTokens, totalOutputTokens - outputTokens);
	const idModel = resolvedModelNameFromId(usage.modelId);
	const sameModelRow = context.modelId === usage.modelId
		? normalizeAntigravityModel(context.model)
		: null;
	const resolvedIdModel = idModel != null && modelResolution(idModel) === 2 ? idModel : null;
	const resolvedSameModelRow = sameModelRow != null && modelResolution(sameModelRow) === 2 ? sameModelRow : null;
	const model = resolvedIdModel
		?? resolvedSameModelRow
		?? idModel
		?? normalizeAntigravityModel(context.model)
		?? DEFAULT_MODEL;
	const { id: messageId, rank: messageIdRank } = preferredMessageId(usage);
	for (const identity of identities) {
		const existing = identityTimestamps.get(identity);
		const shouldUpdate = existing == null
			|| resolved.rank > existing.rank
			|| (resolved.rank === existing.rank && resolved.timestamp < existing.timestamp);
		if (shouldUpdate) {
			identityTimestamps.set(identity, resolved);
		}
	}
	events.push({
		timestamp: resolved.timestamp,
		timestampRank: resolved.rank,
		sessionId: context.sessionId,
		model,
		inputTokens: usage.inputTokens,
		outputTokens,
		cacheCreationTokens: usage.cacheCreationTokens,
		cacheReadTokens: usage.cacheReadTokens,
		reasoningTokens,
		totalOutputTokens,
		messageId,
		messageIdRank,
		identities,
	});
}

/**
 * Merge a duplicate into the kept event: keep the max of every counter, the
 * best-resolved model, and the highest-ranked (then earliest) timestamp.
 */
function mergeUsageEvent(target: AntigravityUsageEvent, duplicate: AntigravityUsageEvent): void {
	target.inputTokens = Math.max(target.inputTokens, duplicate.inputTokens);
	target.outputTokens = Math.max(target.outputTokens, duplicate.outputTokens);
	target.cacheCreationTokens = Math.max(target.cacheCreationTokens, duplicate.cacheCreationTokens);
	target.cacheReadTokens = Math.max(target.cacheReadTokens, duplicate.cacheReadTokens);
	target.reasoningTokens = Math.max(target.reasoningTokens, duplicate.reasoningTokens);
	target.totalOutputTokens = Math.max(
		target.totalOutputTokens,
		duplicate.totalOutputTokens,
		target.outputTokens + target.reasoningTokens,
	);
	if (modelResolution(duplicate.model) > modelResolution(target.model)) {
		target.model = duplicate.model;
	}
	const useDuplicateTimestamp = duplicate.timestampRank > target.timestampRank
		|| (duplicate.timestampRank === target.timestampRank && duplicate.timestamp < target.timestamp);
	if (useDuplicateTimestamp) {
		target.timestamp = duplicate.timestamp;
		target.timestampRank = duplicate.timestampRank;
	}
	if (duplicate.messageIdRank > target.messageIdRank) {
		target.messageId = duplicate.messageId;
		target.messageIdRank = duplicate.messageIdRank;
	}
	for (const identity of duplicate.identities) {
		if (!target.identities.includes(identity)) {
			target.identities.push(identity);
		}
	}
}

/** Merge events that share any identity key (message/response/provider id). */
function deduplicateEvents(events: AntigravityUsageEvent[]): AntigravityUsageEvent[] {
	const slots: Array<AntigravityUsageEvent | null> = [];
	const identityIndexes = new Map<string, number>();
	for (const event of events) {
		const matchingIndexes = [...new Set(
			event.identities
				.map(identity => identityIndexes.get(identity))
				.filter((index): index is number => index != null),
		)].sort((a, b) => a - b);
		const targetIndex = matchingIndexes[0];
		if (targetIndex === undefined) {
			for (const identity of event.identities) {
				identityIndexes.set(identity, slots.length);
			}
			slots.push(event);
			continue;
		}
		for (const duplicateIndex of matchingIndexes.slice(1)) {
			const duplicate = slots[duplicateIndex];
			if (duplicate != null) {
				mergeUsageEvent(slots[targetIndex]!, duplicate);
				slots[duplicateIndex] = null;
			}
		}
		mergeUsageEvent(slots[targetIndex]!, event);
		for (const identity of slots[targetIndex]!.identities) {
			identityIndexes.set(identity, targetIndex);
		}
	}
	return slots.filter((slot): slot is AntigravityUsageEvent => slot != null);
}

/**
 * Parse one Antigravity conversation database. Steps are emitted first (they
 * carry the richer model info), then generation metadata rows; both feed the
 * shared identity map for timestamp resolution.
 */
async function parseAntigravityDb(
	dbPath: string,
	DatabaseSync: typeof import('node:sqlite').DatabaseSync,
): Promise<AntigravityUsageEvent[]> {
	let fallbackTimestamp = 0;
	try {
		fallbackTimestamp = (await stat(dbPath)).mtimeMs;
	}
	catch {}

	const sessionId = path.basename(dbPath, path.extname(dbPath));
	let db: InstanceType<typeof DatabaseSync>;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
	}
	catch (error) {
		logger.warn(`Failed to open Antigravity database at ${dbPath}: ${String(error)}`);
		return [];
	}

	let events: AntigravityUsageEvent[] = [];
	try {
		const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number } | undefined)?.page_count;
		if (pageCount === 0) {
			// Uninitialized snapshot (fresh install) — nothing to read.
			return [];
		}

		let trajectoryTimestamp: number | null = null;
		if (tableExists(db, 'trajectory_metadata_blob')) {
			for (const row of db.prepare('SELECT data FROM trajectory_metadata_blob ORDER BY rowid ASC').all() as { data: Uint8Array }[]) {
				const fields = decodeMessage(row.data);
				if (fields == null) {
					continue;
				}
				const timestampBytes = fieldBytes(fields, 2);
				if (timestampBytes == null) {
					continue;
				}
				const candidate = parseTimestampMessage(timestampBytes);
				if (candidate != null && trajectoryTimestamp == null) {
					trajectoryTimestamp = candidate;
				}
			}
		}

		const generationRows: Array<{ idx: number; metadata: GeneratorMetadata | null }> = [];
		if (tableExists(db, 'gen_metadata')) {
			for (const row of db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all() as { idx: number; data: Uint8Array }[]) {
				generationRows.push({ idx: row.idx, metadata: parseGeneratorMetadata(row.data) });
			}
		}
		const stepRows: Array<{ idx: number; metadata: StepMetadata | null }> = [];
		if (tableExists(db, 'steps')) {
			for (const row of db.prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx ASC').all() as { idx: number; metadata: Uint8Array }[]) {
				stepRows.push({ idx: row.idx, metadata: parseStepMetadata(row.metadata) });
			}
		}

		const identityTimestamps = new Map<string, { timestamp: number; rank: number }>();
		for (const { idx, metadata } of stepRows) {
			if (metadata == null) {
				continue;
			}
			// Row-level resolution: display text wins, then the numeric model id.
			const context: EventContext = {
				model: normalizeAntigravityModel(metadata.model) ?? resolvedModelNameFromId(metadata.modelId),
				modelId: metadata.modelId,
				timestamp: metadata.timestamp,
				trajectoryTimestamp,
				fallbackTimestamp,
				sessionId,
				fallbackIdentities: [`step:${sessionId}:${idx}`],
			};
			if (metadata.usage != null) {
				appendUsageEvent(events, identityTimestamps, metadata.usage, context);
			}
			const retryContext: EventContext = { ...context, fallbackIdentities: [] };
			for (const retry of metadata.retryUsages) {
				appendUsageEvent(events, identityTimestamps, retry, retryContext);
			}
		}

		let currentModel: string | null = null;
		for (const { idx, metadata } of generationRows) {
			if (metadata == null) {
				continue;
			}
			const rowModel = normalizeAntigravityModel(metadata.model)
				?? resolvedModelNameFromId(metadata.modelId)
				?? (metadata.usage != null ? resolvedModelNameFromId(metadata.usage.modelId) : null);
			if (rowModel != null) {
				currentModel = rowModel;
			}
			const fallbackIdentities = metadata.stepIndices.length === 0
				? [`gen:${sessionId}:${idx}`]
				: metadata.stepIndices.map(stepIdx => `step:${sessionId}:${stepIdx}`);
			const context: EventContext = {
				model: currentModel,
				modelId: metadata.modelId,
				timestamp: metadata.timestamp,
				trajectoryTimestamp,
				fallbackTimestamp,
				sessionId,
				fallbackIdentities,
			};
			if (metadata.usage != null) {
				appendUsageEvent(events, identityTimestamps, metadata.usage, context);
			}
			const retryContext: EventContext = { ...context, fallbackIdentities: [] };
			for (const retry of metadata.retryUsages) {
				appendUsageEvent(events, identityTimestamps, retry, retryContext);
			}
		}
	}
	catch (error) {
		logger.warn(`Failed to parse Antigravity database ${dbPath}: ${String(error)}`);
	}
	finally {
		// db.close() is available on every node:sqlite release we support;
		// Symbol.dispose only landed on DatabaseSync in Node 22.15.
		db.close();
	}
	events = deduplicateEvents(events);
	return events;
}

function tableExists(db: InstanceType<typeof import('node:sqlite').DatabaseSync>, table: string): boolean {
	const row = db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ? LIMIT 1').get(table);
	return row != null;
}

/**
 * Resolve the Antigravity conversation directories.
 *
 * Honors the `ANTIGRAVITY_DATA_DIR` environment variable (comma-separated
 * list of roots), otherwise scans the default home roots and keeps those with
 * a `conversations/` subdirectory (a root without it is a fresh install whose
 * root-level databases are only conversation summaries).
 */
export function getAntigravityPaths(): string[] {
	const envDir = process.env[ANTIGRAVITY_DATA_DIR_ENV]?.trim();
	if (envDir != null && envDir !== '') {
		return envDir
			.split(',')
			.map(p => p.trim())
			.filter(p => p !== '')
			.map((p) => {
				const resolved = path.resolve(p);
				const nested = path.join(resolved, ANTIGRAVITY_CONVERSATIONS_DIR);
				return existsSync(nested) ? nested : resolved;
			});
	}

	if (process.env.VITEST != null) {
		return [''];
	}

	const dirs: string[] = [];
	for (const root of DEFAULT_ANTIGRAVITY_ROOT_PATHS) {
		const candidate = path.join(USER_HOME_DIR, root);
		const nested = path.join(candidate, ANTIGRAVITY_CONVERSATIONS_DIR);
		if (existsSync(nested)) {
			dirs.push(nested);
		}
	}
	return dirs;
}

/**
 * Read every Antigravity conversation database under the given directories
 * and transform the decoded usage events into {@link UsageData} entries.
 */
export async function processAntigravitySessions(dataDirs: string[], _options: LoadOptions = {}): Promise<UsageData[]> {
	if (dataDirs.length === 0 || (dataDirs.length === 1 && dataDirs[0] === '')) {
		logger.debug('Antigravity data directories are empty, skipping');
		return [];
	}

	// Lazy-import node:sqlite so the module loads on runtimes that lack it.
	let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
	try {
		({ DatabaseSync } = await import('node:sqlite'));
	}
	catch (error) {
		logger.warn(`node:sqlite is not available on this runtime; Antigravity usage disabled. ${String(error)}`);
		return [];
	}

	const files: string[] = [];
	for (const dir of dataDirs) {
		files.push(...await glob(['*.db'], { cwd: dir, absolute: true, onlyFiles: true }));
	}
	files.sort();

	const events: AntigravityUsageEvent[] = [];
	for (const file of files) {
		try {
			events.push(...await parseAntigravityDb(file, DatabaseSync));
		}
		catch (error) {
			logger.warn(`Failed to load Antigravity database ${file}: ${String(error)}`);
		}
	}
	const deduplicated = deduplicateEvents(events);
	deduplicated.sort((a, b) => a.timestamp - b.timestamp);

	const results: UsageData[] = deduplicated.map((event, index) => {
		// Prefix with the source so the shared loader-level dedup key can never
		// collide with an identical raw id from another source.
		const messageId = `antigravity:${event.messageId ?? `${event.sessionId}:${event.identities[0] ?? index}:${event.timestamp}`}`;
		return {
			timestamp: createISOTimestamp(new Date(event.timestamp).toISOString()),
			sessionId: createSessionId(event.sessionId),
			version: createVersion('1.0.0'),
			message: {
				usage: {
					// Antigravity input excludes the cached shares; total output
					// (visible + reasoning) is billed at the output rate.
					input_tokens: event.inputTokens,
					output_tokens: event.totalOutputTokens,
					cache_creation_input_tokens: event.cacheCreationTokens,
					cache_read_input_tokens: event.cacheReadTokens,
				},
				model: createModelName(event.model),
				id: createMessageId(messageId),
			},
			requestId: createRequestId(messageId),
			cwd: path.join('antigravity', 'unknown'),
			source: createSource('antigravity'),
		} satisfies UsageData;
	});

	if (results.length > 0) {
		logger.info(`Loaded ${results.length} Antigravity usage entries from ${dataDirs.join(', ')}`);
	}
	return results;
}

if (import.meta.vitest != null) {
	// eslint-disable-next-line antfu/no-top-level-await -- test-only hoisted import inside the vitest guard
	const { DatabaseSync } = await import('node:sqlite');

	/**
	 * Minimal protobuf encoder for fixtures (varint + length-delimited only).
	 *
	 * Note for Windows: create, insert, and dispose in a SINGLE open. Reopening
	 * a multi-table database right after disposing it keeps a lingering handle
	 * on some runtimes and the fixture cleanup then fails with EBUSY.
	 */
	const testTextEncoder = new TextEncoder();

	function encodeVarint(value: number): number[] {
		const bytes: number[] = [];
		let rest = value;
		for (;;) {
			const byte = rest % 128;
			rest = Math.floor(rest / 128);
			bytes.push(rest > 0 ? byte + 128 : byte);
			if (rest === 0) {
				break;
			}
		}
		return bytes;
	}

	function encodeField(number: number, payload: number[] | Uint8Array | string | number): number[] {
		const isBytes = typeof payload === 'string' || Array.isArray(payload) || payload instanceof Uint8Array;
		const tag = number * 8 + (isBytes ? 2 : 0);
		if (!isBytes) {
			return [...encodeVarint(tag), ...encodeVarint(payload)];
		}
		const body = typeof payload === 'string'
			? [...testTextEncoder.encode(payload)]
			: payload instanceof Uint8Array
				? [...payload]
				: payload;
		return [...encodeVarint(tag), ...encodeVarint(body.length), ...body];
	}

	function encodeTimestamp(seconds: number): number[] {
		// Timestamp { seconds = field 1 }
		return encodeField(1, [...encodeField(1, seconds)]);
	}

	function encodeModelUsage(usage: {
		modelId?: number;
		input?: number;
		totalOutput?: number;
		cacheCreation?: number;
		cacheRead?: number;
		reasoning?: number;
		visibleOutput?: number;
		messageId?: string;
		responseId?: string;
	}): number[] {
		const body: number[] = [];
		if (usage.modelId != null) {
			body.push(...encodeField(1, usage.modelId));
		}
		if (usage.input != null) {
			body.push(...encodeField(2, usage.input));
		}
		if (usage.totalOutput != null) {
			body.push(...encodeField(3, usage.totalOutput));
		}
		if (usage.cacheCreation != null) {
			body.push(...encodeField(4, usage.cacheCreation));
		}
		if (usage.cacheRead != null) {
			body.push(...encodeField(5, usage.cacheRead));
		}
		if (usage.messageId != null) {
			body.push(...encodeField(7, usage.messageId));
		}
		if (usage.reasoning != null) {
			body.push(...encodeField(9, usage.reasoning));
		}
		if (usage.visibleOutput != null) {
			body.push(...encodeField(10, usage.visibleOutput));
		}
		if (usage.responseId != null) {
			body.push(...encodeField(11, usage.responseId));
		}
		return body;
	}

	/** Create a conversation database and insert rows in one single open. */
	function withAntigravityDb(dir: string, name: string, insert: (db: InstanceType<typeof DatabaseSync>) => void): string {
		const dbPath = `${dir}/${name}.db`;
		const db = new DatabaseSync(dbPath);
		db.exec(`
			CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
			CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);
			CREATE TABLE trajectory_metadata_blob (id INTEGER PRIMARY KEY, data BLOB);
		`);
		insert(db);
		db.close();
		return dbPath;
	}

	it('decodes step usage with model id, cache buckets and reasoning', async () => {
		await using fixture = await createFixture({});
		withAntigravityDb(fixture.path, 'conv-a', (db) => {
			// steps.metadata: field 24 model_info { 1 = model_id 1318 }, field 9 usage.
			const modelInfo = [...encodeField(1, 1318)];
			const usage = encodeModelUsage({ input: 1000, totalOutput: 500, cacheRead: 200, reasoning: 100, visibleOutput: 400, responseId: 'resp-1' });
			const stepMetadata = [
				...encodeField(24, modelInfo),
				...encodeField(9, usage),
				...encodeField(8, encodeTimestamp(1777388092)),
			];
			db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(1, new Uint8Array(stepMetadata));
		});

		const results = await processAntigravitySessions([fixture.path]);

		expect(results).toHaveLength(1);
		const entry = results[0]!;
		expect(entry.source).toBe('antigravity');
		expect(entry.sessionId).toBe('conv-a');
		expect(entry.message.model).toBe('gemini-3.8-flash-high');
		expect(entry.message.usage.input_tokens).toBe(1000);
		// Billed output is total output (visible 400 + reasoning 100).
		expect(entry.message.usage.output_tokens).toBe(500);
		expect(entry.message.usage.cache_read_input_tokens).toBe(200);
		expect(entry.message.id).toBe('antigravity:resp-1');
	});

	it('decodes gen_metadata usage and maps placeholder names', async () => {
		await using fixture = await createFixture({});
		withAntigravityDb(fixture.path, 'conv-b', (db) => {
			// gen_metadata: root field 1 = chat model { 3 = model_id, 4 = usage, 19 = model text }.
			const usage = encodeModelUsage({ input: 50, totalOutput: 20, visibleOutput: 20, messageId: 'msg-9' });
			const chatModel = [
				...encodeField(3, 1318),
				...encodeField(4, usage),
				...encodeField(19, 'model_placeholder_m320'),
			];
			db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, new Uint8Array([...encodeField(1, chatModel)]));
		});

		const results = await processAntigravitySessions([fixture.path]);

		expect(results).toHaveLength(1);
		expect(results[0]!.message.model).toBe('gemini-3.8-flash-low');
		expect(results[0]!.message.usage.input_tokens).toBe(50);
		expect(results[0]!.message.usage.output_tokens).toBe(20);
		expect(results[0]!.message.id).toBe('antigravity:msg-9');
	});

	it('deduplicates events sharing an identity across databases', async () => {
		await using fixture = await createFixture({});

		for (const [index, name] of ['dup-1', 'dup-2'].entries()) {
			withAntigravityDb(fixture.path, name, (db) => {
				const usage = encodeModelUsage({
					input: 300,
					totalOutput: 40,
					visibleOutput: 40,
					responseId: 'shared-resp',
				});
				const stepMetadata = [
					...encodeField(24, [...encodeField(1, 1050)]),
					...encodeField(9, usage),
				];
				db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(index + 1, new Uint8Array(stepMetadata));
			});
		}

		const results = await processAntigravitySessions([fixture.path]);

		// The same response id in two databases is one billable event.
		expect(results).toHaveLength(1);
		expect(results[0]!.message.usage.input_tokens).toBe(300);
		expect(results[0]!.message.model).toBe('gemini-3.1-flash-lite');
	});

	it('returns empty for uninitialized databases', async () => {
		await using fixture = await createFixture({});
		const dbPath = `${fixture.path}/fresh.db`;
		const db = new DatabaseSync(dbPath);
		db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
		db.close();

		const results = await processAntigravitySessions([fixture.path]);

		expect(results).toHaveLength(0);
	});
}
