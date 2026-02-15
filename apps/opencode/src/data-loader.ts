import type { ModelPricing } from '@better-ccusage/internal/pricing';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { PricingFetcher } from '@better-ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { groupBy, sortBy } from 'es-toolkit';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import { calculateCostForEntry, type LoadedUsageEntry } from './cost-utils.ts';
import { logger } from './logger.ts';

const require = createRequire(import.meta.url);

/**
 * Load pricing data from internal package
 * The JSON file is bundled with the internal package
 */
async function loadPricingData(): Promise<Record<string, ModelPricing>> {
	try {
		// Try to load from internal package (works in dev mode)
		const internalPath = require.resolve('@better-ccusage/internal/package.json');
		const internalDir = internalPath.replace('/package.json', '');
		const pricingPath = `${internalDir}/../model_prices_and_context_window.json`;
		const content = await readFile(pricingPath, 'utf-8');
		return JSON.parse(content) as Record<string, ModelPricing>;
	}
	catch {
		// Fallback: try loading from better-ccusage dist
		try {
			const betterCcusagePath = require.resolve('better-ccusage/package.json');
			const content = await readFile(`${betterCcusagePath.replace('/package.json', '')}/model_prices_and_context_window.json`, 'utf-8');
			return JSON.parse(content) as Record<string, ModelPricing>;
		}
		catch {
			// Last resort: return empty object
			logger.warn('Could not load pricing data, costs will be $0.00');
			return {};
		}
	}
}

/**
 * Get the OpenCode data directory path
 * Default: ~/.local/share/opencode/storage/
 */
export function getOpenCodePath(): string {
	const baseDir = process.env.OPENCODE_DATA_DIR
		?? process.env.XDG_DATA_HOME
		?? `${process.env.HOME ?? ''}/.local/share`;
	return `${baseDir}/opencode/storage`;
}

/**
 * OpenCode message tokens schema
 * Matches the token structure in OpenCode message files
 */
export const openCodeTokensSchema = v.object({
	input: v.number(),
	output: v.number(),
	cacheWrite: v.optional(v.number()),
	cacheRead: v.optional(v.number()),
});

/**
 * OpenCode message schema
 * Represents a single message file in OpenCode
 * Location: ~/.local/share/opencode/storage/message/{sessionID}/msg_{id}.json
 */
export const openCodeMessageSchema = v.object({
	id: v.string(),
	sessionID: v.string(),
	timestamp: v.string(),
	role: v.picklist(['user', 'assistant']),
	content: v.string(),
	tokens: v.optional(openCodeTokensSchema),
	cost: v.optional(v.number()),
	model: v.optional(v.string()),
	provider: v.optional(v.string()),
	parentID: v.optional(v.string()),
});

export type OpenCodeMessage = v.InferOutput<typeof openCodeMessageSchema>;

/**
 * OpenCode session metadata schema
 * Location: ~/.local/share/opencode/storage/session/{sessionID}.json
 */
export const openCodeSessionSchema = v.object({
	id: v.string(),
	createdAt: v.string(),
	updatedAt: v.optional(v.string()),
	parentID: v.optional(v.string()),
	description: v.optional(v.string()),
	model: v.optional(v.string()),
	provider: v.optional(v.string()),
	cost: v.optional(v.number()),
	promptTokens: v.optional(v.number()),
	completionTokens: v.optional(v.number()),
	totalTokens: v.optional(v.number()),
});

export type OpenCodeSession = v.InferOutput<typeof openCodeSessionSchema>;

/**
 * Session metadata with subagent hierarchy information
 */
export type LoadedSessionMetadata = OpenCodeSession & {
	/** Child sessions (subagents) */
	children: LoadedSessionMetadata[];
	/** Depth in the hierarchy (0 = root) */
	depth: number;
};

/**
 * Aggregated usage data for a period (daily, weekly, monthly)
 */
export type AggregatedUsageData = {
	/** Period identifier (date, week, month) */
	period: string;
	/** Source identifier (opencode) */
	source: string;
	/** Input tokens */
	inputTokens: number;
	/** Output tokens */
	outputTokens: number;
	/** Cache creation tokens */
	cacheCreationTokens: number;
	/** Cache read tokens */
	cacheReadTokens: number;
	/** Total tokens */
	totalTokens: number;
	/** Total cost in USD */
	totalCost: number;
	/** Models used in this period */
	modelsUsed: string[];
	/** Model breakdowns */
	modelBreakdowns: ModelBreakdown[];
};

/**
 * Model breakdown for detailed cost analysis
 */
export type ModelBreakdown = {
	modelName: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	cost: number;
};

/**
 * Load all OpenCode message files
 * Searches in ~/.local/share/opencode/storage/message/{sessionID}/msg_{id}.json
 */
export async function loadOpenCodeMessages(): Promise<LoadedUsageEntry[]> {
	const basePath = getOpenCodePath();
	const messagePattern = `${basePath}/message/**/msg_*.json`;

	const files = await glob(messagePattern);
	logger.debug(`Found ${files.length} OpenCode message files`);

	const entries: LoadedUsageEntry[] = [];
	const fetcher = new PricingFetcher({
		offlineLoader: loadPricingData,
	});

	for (const file of files) {
		const result = await Result.try({
			try: async () => {
				const content = await readFile(file, 'utf-8');
				const parsed = JSON.parse(content);
				return v.parse(openCodeMessageSchema, parsed);
			},
			catch: (error) => new Error(`Failed to parse ${file}: ${error}`),
		})();

		if (Result.isFailure(result)) {
			logger.warn(result.error.message);
			continue;
		}

		const message = result.value;

		// Skip entries without tokens
		if (message.tokens == null) {
			continue;
		}

		const entry: LoadedUsageEntry = {
			timestamp: new Date(message.timestamp),
			sessionId: message.sessionID,
			model: message.model ?? 'unknown',
			provider: message.provider ?? 'unknown',
			inputTokens: message.tokens.input,
			outputTokens: message.tokens.output,
			cacheCreationTokens: message.tokens.cacheWrite ?? 0,
			cacheReadTokens: message.tokens.cacheRead ?? 0,
			cost: message.cost ?? 0,
		};

		// Calculate cost if not provided
		if (entry.cost === 0) {
			entry.cost = await calculateCostForEntry(entry, fetcher);
		}

		entries.push(entry);
	}

	// Sort by timestamp
	return sortBy(entries, [(e) => e.timestamp.getTime()]);
}

/**
 * Load all OpenCode session metadata files
 * Searches in ~/.local/share/opencode/storage/session/{sessionID}.json
 */
export async function loadOpenCodeSessions(): Promise<LoadedSessionMetadata[]> {
	const basePath = getOpenCodePath();
	const sessionPattern = `${basePath}/session/*.json`;

	const files = await glob(sessionPattern);
	logger.debug(`Found ${files.length} OpenCode session files`);

	const sessions: OpenCodeSession[] = [];

	for (const file of files) {
		const result = await Result.try({
			try: async () => {
				const content = await readFile(file, 'utf-8');
				const parsed = JSON.parse(content);
				return v.parse(openCodeSessionSchema, parsed);
			},
			catch: (error) => new Error(`Failed to parse ${file}: ${error}`),
		})();

		if (Result.isFailure(result)) {
			logger.warn(result.error.message);
			continue;
		}

		sessions.push(result.value);
	}

	// Build hierarchy
	return buildSessionHierarchy(sessions);
}

/**
 * Build session hierarchy from flat list
 * Sessions with parentID are nested under their parent
 */
function buildSessionHierarchy(sessions: OpenCodeSession[]): LoadedSessionMetadata[] {
	const sessionMap = new Map<string, LoadedSessionMetadata>();
	const rootSessions: LoadedSessionMetadata[] = [];

	// First pass: create all session metadata
	for (const session of sessions) {
		sessionMap.set(session.id, {
			...session,
			children: [],
			depth: 0,
		});
	}

	// Second pass: build hierarchy
	for (const session of sessions) {
		const metadata = sessionMap.get(session.id);
		if (metadata == null) continue;

		if (session.parentID != null) {
			const parent = sessionMap.get(session.parentID);
			if (parent != null) {
				metadata.depth = parent.depth + 1;
				parent.children.push(metadata);
			}
			else {
				// Parent not found, treat as root
				rootSessions.push(metadata);
			}
		}
		else {
			rootSessions.push(metadata);
		}
	}

	return rootSessions;
}

/**
 * Aggregate usage data by day
 */
export async function loadDailyUsageData(): Promise<AggregatedUsageData[]> {
	const entries = await loadOpenCodeMessages();

	if (entries.length === 0) {
		return [];
	}

	const grouped = groupBy(entries, (e) => {
		const date = new Date(e.timestamp);
		return date.toISOString().split('T')[0] ?? '';
	});

	const results: AggregatedUsageData[] = [];

	for (const [date, dayEntries] of Object.entries(grouped)) {
		if (dayEntries == null || dayEntries.length === 0) continue;

		const modelBreakdowns = createModelBreakdowns(dayEntries);
		const modelsUsed = [...new Set(dayEntries.map(e => e.model))];

		results.push({
			period: date,
			source: 'opencode',
			inputTokens: dayEntries.reduce((sum, e) => sum + e.inputTokens, 0),
			outputTokens: dayEntries.reduce((sum, e) => sum + e.outputTokens, 0),
			cacheCreationTokens: dayEntries.reduce((sum, e) => sum + e.cacheCreationTokens, 0),
			cacheReadTokens: dayEntries.reduce((sum, e) => sum + e.cacheReadTokens, 0),
			totalTokens: dayEntries.reduce((sum, e) => sum + e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens, 0),
			totalCost: dayEntries.reduce((sum, e) => sum + e.cost, 0),
			modelsUsed,
			modelBreakdowns,
		});
	}

	return sortBy(results, [(r) => r.period]);
}

/**
 * Aggregate usage data by week (ISO format: YYYY-Www)
 */
export async function loadWeeklyUsageData(): Promise<AggregatedUsageData[]> {
	const entries = await loadOpenCodeMessages();

	if (entries.length === 0) {
		return [];
	}

	const grouped = groupBy(entries, (e) => {
		const date = new Date(e.timestamp);
		return getISOWeek(date);
	});

	const results: AggregatedUsageData[] = [];

	for (const [week, weekEntries] of Object.entries(grouped)) {
		if (weekEntries == null || weekEntries.length === 0) continue;

		const modelBreakdowns = createModelBreakdowns(weekEntries);
		const modelsUsed = [...new Set(weekEntries.map(e => e.model))];

		results.push({
			period: week,
			source: 'opencode',
			inputTokens: weekEntries.reduce((sum, e) => sum + e.inputTokens, 0),
			outputTokens: weekEntries.reduce((sum, e) => sum + e.outputTokens, 0),
			cacheCreationTokens: weekEntries.reduce((sum, e) => sum + e.cacheCreationTokens, 0),
			cacheReadTokens: weekEntries.reduce((sum, e) => sum + e.cacheReadTokens, 0),
			totalTokens: weekEntries.reduce((sum, e) => sum + e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens, 0),
			totalCost: weekEntries.reduce((sum, e) => sum + e.cost, 0),
			modelsUsed,
			modelBreakdowns,
		});
	}

	return sortBy(results, [(r) => r.period]);
}

/**
 * Aggregate usage data by month (YYYY-MM)
 */
export async function loadMonthlyUsageData(): Promise<AggregatedUsageData[]> {
	const entries = await loadOpenCodeMessages();

	if (entries.length === 0) {
		return [];
	}

	const grouped = groupBy(entries, (e) => {
		const date = new Date(e.timestamp);
		return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
	});

	const results: AggregatedUsageData[] = [];

	for (const [month, monthEntries] of Object.entries(grouped)) {
		if (monthEntries == null || monthEntries.length === 0) continue;

		const modelBreakdowns = createModelBreakdowns(monthEntries);
		const modelsUsed = [...new Set(monthEntries.map(e => e.model))];

		results.push({
			period: month,
			source: 'opencode',
			inputTokens: monthEntries.reduce((sum, e) => sum + e.inputTokens, 0),
			outputTokens: monthEntries.reduce((sum, e) => sum + e.outputTokens, 0),
			cacheCreationTokens: monthEntries.reduce((sum, e) => sum + e.cacheCreationTokens, 0),
			cacheReadTokens: monthEntries.reduce((sum, e) => sum + e.cacheReadTokens, 0),
			totalTokens: monthEntries.reduce((sum, e) => sum + e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens, 0),
			totalCost: monthEntries.reduce((sum, e) => sum + e.cost, 0),
			modelsUsed,
			modelBreakdowns,
		});
	}

	return sortBy(results, [(r) => r.period]);
}

/**
 * Get ISO week string (YYYY-Www)
 */
function getISOWeek(date: Date): string {
	const tempDate = new Date(date.valueOf());
	tempDate.setHours(0, 0, 0, 0);
	// Thursday in current week decides the year
	tempDate.setDate(tempDate.getDate() + 3 - ((tempDate.getDay() + 6) % 7));
	// January 4 is always in week 1
	const week1 = new Date(tempDate.getFullYear(), 0, 4);
	// Adjust to Thursday in week 1 and count number of weeks from date to week1
	const weekNumber = 1 + Math.round(((tempDate.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
	return `${tempDate.getFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

/**
 * Create model breakdowns from entries
 */
function createModelBreakdowns(entries: LoadedUsageEntry[]): ModelBreakdown[] {
	const grouped = groupBy(entries, e => e.model);

	const breakdowns: ModelBreakdown[] = [];

	for (const [model, modelEntries] of Object.entries(grouped)) {
		if (modelEntries == null || modelEntries.length === 0) continue;

		breakdowns.push({
			modelName: model,
			inputTokens: modelEntries.reduce((sum, e) => sum + e.inputTokens, 0),
			outputTokens: modelEntries.reduce((sum, e) => sum + e.outputTokens, 0),
			cacheCreationTokens: modelEntries.reduce((sum, e) => sum + e.cacheCreationTokens, 0),
			cacheReadTokens: modelEntries.reduce((sum, e) => sum + e.cacheReadTokens, 0),
			cost: modelEntries.reduce((sum, e) => sum + e.cost, 0),
		});
	}

	return sortBy(breakdowns, [(b) => b.modelName]);
}

if (import.meta.vitest != null) {
	describe('getOpenCodePath', () => {
		it('returns default path when no env vars set', () => {
			const originalHome = process.env.HOME;
			process.env.HOME = '/home/test';
			delete process.env.OPENCODE_DATA_DIR;
			delete process.env.XDG_DATA_HOME;

			const path = getOpenCodePath();
			expect(path).toBe('/home/test/.local/share/opencode/storage');

			process.env.HOME = originalHome;
		});

		it('uses OPENCODE_DATA_DIR when set', () => {
			const original = process.env.OPENCODE_DATA_DIR;
			process.env.OPENCODE_DATA_DIR = '/custom';

			const path = getOpenCodePath();
			expect(path).toBe('/custom/opencode/storage');

			process.env.OPENCODE_DATA_DIR = original;
		});

		it('uses XDG_DATA_HOME when set', () => {
			delete process.env.OPENCODE_DATA_DIR;
			const original = process.env.XDG_DATA_HOME;
			process.env.XDG_DATA_HOME = '/custom/xdg';

			const path = getOpenCodePath();
			expect(path).toBe('/custom/xdg/opencode/storage');

			process.env.XDG_DATA_HOME = original;
		});
	});

	describe('getISOWeek', () => {
		it('returns correct ISO week format', () => {
			expect(getISOWeek(new Date('2026-02-14'))).toBe('2026-W07');
			expect(getISOWeek(new Date('2026-01-01'))).toBe('2026-W01');
			expect(getISOWeek(new Date('2026-12-31'))).toBe('2026-W53');
		});
	});
}
