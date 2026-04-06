/**
 * @fileoverview Optimized data loader for the statusline command.
 *
 * Performs a single pass over JSONL files to compute session cost, daily cost,
 * and active block info — replacing the previous 3 separate data-loading calls
 * that each re-scanned all files independently.
 */

import type { CcusagePricingFetcher } from './_pricing-fetcher.ts';
import type { LoadedUsageEntry, SessionBlock } from './_session-blocks.ts';
import type { CostMode } from './_types.ts';
import type { UserMessage } from './data-loader.ts';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import { CLAUDE_PROJECTS_DIR_NAME } from './_consts.ts';
import { identifySessionBlocks } from './_session-blocks.ts';
import { calculateCostForEntry, createUniqueHash, getClaudePaths, getUsageLimitResetTime, globUsageFiles, usageDataSchema, userMessageSchema } from './data-loader.ts';

export type StatuslineDataOptions = {
	sessionId: string;
	todayStr: string;
	mode: CostMode;
	sessionDurationHours?: number;
};

export type StatuslineDataResult = {
	sessionCost: number;
	todayCost: number;
	activeBlock: SessionBlock | null;
};

async function getFileMtime(filePath: string): Promise<number> {
	try {
		const s = await stat(filePath);
		return s.mtimeMs;
	}
	catch {
		return 0;
	}
}

/**
 * Performs a single pass over JSONL files to compute session cost, daily cost,
 * and active block info for the statusline display.
 *
 * @param options - Statusline data loading configuration
 * @param options.sessionId - Current Claude Code session ID
 * @param options.todayStr - Today's date string (YYYYMMDD)
 * @param options.mode - Cost calculation mode
 * @param fetcher - Shared pricing fetcher instance
 * @returns Session cost, today's cost, and the active billing block (if any)
 */
export async function loadStatuslineData(
	options: StatuslineDataOptions,
	fetcher: CcusagePricingFetcher,
): Promise<StatuslineDataResult> {
	const claudePaths = getClaudePaths();

	// 1. Find the session file directly (targeted glob)
	const sessionFilePatterns = claudePaths.map(
		p => path.join(p, CLAUDE_PROJECTS_DIR_NAME, '**', `${options.sessionId}.jsonl`).replaceAll('\\', '/'),
	);
	const sessionFiles = await glob(sessionFilePatterns, { absolute: true });
	const sessionFile = sessionFiles[0] ?? null;

	// 2. Glob all usage files once
	const allFiles = await globUsageFiles(claudePaths);
	const fileList = allFiles.map(f => f.file);

	// 3. Filter files by mtime before reading
	const now = new Date();
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const blockWindowStart = new Date(now.getTime() - (options.sessionDurationHours ?? 5) * 60 * 60 * 1000);
	const blockWindowStartMs = blockWindowStart.getTime();

	const fileMtimeResults = await Promise.all(
		fileList.map(async file => ({ file, mtime: await getFileMtime(file) })),
	);

	// Files modified today (for daily cost) OR within block window (for block cost)
	const filesToReadSet = new Set<string>();
	for (const { file, mtime } of fileMtimeResults) {
		if (mtime >= todayStart.getTime() || mtime >= blockWindowStartMs) {
			filesToReadSet.add(file);
		}
	}

	// Always include session file if found
	if (sessionFile != null) {
		filesToReadSet.add(sessionFile);
	}

	if (filesToReadSet.size === 0) {
		return { sessionCost: 0, todayCost: 0, activeBlock: null };
	}

	// 4. Read files concurrently (mtimes already filtered the set)
	const filesToRead = [...filesToReadSet];
	const fileContents = await Promise.allSettled(
		filesToRead.map(async (file) => {
			const content = await readFile(file, 'utf-8');
			return { file, content };
		}),
	);

	// 5. Single pass over all entries
	let sessionCost = 0;
	let todayCost = 0;
	const blockEntries: LoadedUsageEntry[] = [];
	const blockUserMessages: UserMessage[] = [];
	const processedHashes = new Set<string>();

	for (const result of fileContents) {
		if (result.status !== 'fulfilled') {
			continue;
		}

		const { file, content } = result.value;
		const isSessionFile = sessionFile != null && path.resolve(file) === path.resolve(sessionFile);
		const lines = content.trim().split('\n').filter(l => l.length > 0);

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as unknown;

				// Try usage data schema
				const usageResult = v.safeParse(usageDataSchema, parsed);
				if (usageResult.success) {
					const data = usageResult.output;

					// Deduplication
					const hash = createUniqueHash(data);
					if (hash != null && processedHashes.has(hash)) {
						continue;
					}
					if (hash != null) {
						processedHashes.add(hash);
					}

					const cost = await calculateCostForEntry(data, options.mode, fetcher);

					// Session cost (only from session file)
					if (isSessionFile) {
						sessionCost += cost;
					}

					// Daily cost (entries from today)
					const entryDate = new Date(data.timestamp);
					if (entryDate >= todayStart) {
						todayCost += cost;
					}

					// Block entries (entries within block window)
					if (entryDate >= blockWindowStart) {
						const usageLimitResetTime = getUsageLimitResetTime(data);
						blockEntries.push({
							timestamp: entryDate,
							usage: {
								inputTokens: data.message.usage.input_tokens,
								outputTokens: data.message.usage.output_tokens,
								cacheCreationInputTokens: data.message.usage.cache_creation_input_tokens ?? 0,
								cacheReadInputTokens: data.message.usage.cache_read_input_tokens ?? 0,
							},
							costUSD: cost,
							model: data.message.model ?? 'unknown',
							version: data.version,
							usageLimitResetTime: usageLimitResetTime ?? undefined,
						});
					}

					continue;
				}

				// Try user message schema (for block prompt counting)
				const userResult = v.safeParse(userMessageSchema, parsed);
				if (userResult.success) {
					const entryDate = new Date(userResult.output.timestamp);
					if (entryDate >= blockWindowStart) {
						blockUserMessages.push(userResult.output);
					}
				}
			}
			catch {
				// Skip invalid lines
			}
		}
	}

	// 6. Compute block info
	const blocks = identifySessionBlocks(
		blockEntries,
		blockUserMessages,
		options.sessionDurationHours,
	);
	const activeBlock = blocks.find(b => b.isActive) ?? null;

	return { sessionCost, todayCost, activeBlock };
}

if (import.meta.vitest != null) {
	describe('loadStatuslineData', () => {
		it('returns zeros when no files exist', async () => {
			const { createFixture } = await import('fs-fixture');
			const { createSharedPricingFetcher } = await import('./_pricing-fetcher.ts');

			await using fixture = await createFixture({
				projects: {},
			});

			const { vi } = await import('vitest');
			vi.stubEnv('CLAUDE_CONFIG_DIR', fixture.path);

			try {
				using fetcher = createSharedPricingFetcher();
				const result = await loadStatuslineData(
					{ sessionId: 'test-session', todayStr: '20260101', mode: 'auto' },
					fetcher,
				);
				expect(result.sessionCost).toBe(0);
				expect(result.todayCost).toBe(0);
				expect(result.activeBlock).toBeNull();
			}
			finally {
				vi.unstubAllEnvs();
			}
		});
	});
}
