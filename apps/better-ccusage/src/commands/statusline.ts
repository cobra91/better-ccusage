import type { Formatter } from 'picocolors/types';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { formatCurrency } from '@better-ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { createLimoJson } from '@ryoppippi/limo';
import getStdin from 'get-stdin';
import { define } from 'gunshi';
import pc from 'picocolors';
import * as v from 'valibot';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { DEFAULT_CONTEXT_USAGE_THRESHOLDS, DEFAULT_STATUSLINE_REFRESH_INTERVAL_SECONDS } from '../_consts.ts';
import { createSharedPricingFetcher } from '../_pricing-fetcher.ts';
import { calculateBurnRate } from '../_session-blocks.ts';
import { sharedArgs } from '../_shared-args.ts';
import { loadStatuslineData } from '../_statusline-loader.ts';
import { statuslineHookJsonSchema } from '../_types.ts';
import { getFileModifiedTime, unreachable } from '../_utils.ts';
import { calculateContextTokens } from '../data-loader.ts';
import { log, logger } from '../logger.ts';

/**
 * Formats the remaining time for display
 * @param remaining - Remaining minutes
 * @returns Formatted time string
 */
function formatRemainingTime(remaining: number): string {
	const remainingHours = Math.floor(remaining / 60);
	const remainingMins = remaining % 60;

	if (remainingHours > 0) {
		return `${remainingHours}h ${remainingMins}m left`;
	}
	return `${remainingMins}m left`;
}

/**
 * Gets semaphore file for session-specific caching and process coordination
 * Uses time-based expiry and transcript file modification detection for cache invalidation
 */
function getSemaphore(sessionId: string): ReturnType<typeof createLimoJson<SemaphoreType | undefined>> {
	const semaphoreDir = join(tmpdir(), 'better-ccusage-semaphore');
	const semaphorePath = join(semaphoreDir, `${sessionId}.lock`);

	// Ensure semaphore directory exists
	mkdirSync(semaphoreDir, { recursive: true });

	const semaphore = createLimoJson<SemaphoreType>(semaphorePath);
	return semaphore;
}

/**
 * Semaphore structure for hybrid caching system
 * Combines time-based expiry with transcript file modification detection
 */
type SemaphoreType = {
	/** ISO timestamp of last update */
	date: string;
	/** Cached status line output */
	lastOutput: string;
	/** Timestamp (milliseconds) of last successful update for time-based expiry */
	lastUpdateTime: number;
	/** Last processed transcript file path */
	transcriptPath: string;
	/** Last modification time of transcript file for change detection */
	transcriptMtime: number;
	/** Whether another process is currently updating (prevents concurrent updates) */
	isUpdating?: boolean;
	/** Process ID of updating process for deadlock detection */
	pid?: number;
};

const visualBurnRateChoices = ['off', 'emoji', 'text', 'emoji-text'] as const;
const costSourceChoices = ['auto', 'better-ccusage', 'cc', 'both'] as const;

// Valibot schema for context threshold validation
const contextThresholdSchema = v.pipe(
	v.union([
		v.number(),
		v.pipe(
			v.string(),
			v.trim(),
			v.check(
				value => /^-?\d+$/u.test(value),
				'Context threshold must be an integer',
			),
			v.transform(value => Number.parseInt(value, 10)),
		),
	]),
	v.number('Context threshold must be a number'),
	v.integer('Context threshold must be an integer'),
	v.minValue(0, 'Context threshold must be at least 0'),
	v.maxValue(100, 'Context threshold must be at most 100'),
);

function parseContextThreshold(value: string): number {
	return v.parse(contextThresholdSchema, value);
}

export const statuslineCommand = define({
	name: 'statusline',
	description: 'Display compact status line for Claude Code hooks with hybrid time+file caching (Beta)',
	toKebab: true,
	args: {
		visualBurnRate: {
			type: 'enum',
			choices: visualBurnRateChoices,
			description: 'Controls the visualization of the burn rate status',
			default: 'off',
			// Use capital 'B' to avoid conflicts and follow 1-letter short alias rule
			short: 'B',
			negatable: false,
			toKebab: true,
		},
		costSource: {
			type: 'enum',
			choices: costSourceChoices,
			description: 'Session cost source: auto (prefer CC then better-ccusage), better-ccusage (always calculate), cc (always use Claude Code cost), both (show both costs)',
			default: 'auto',
			negatable: false,
			toKebab: true,
		},
		cache: {
			type: 'boolean',
			description: 'Enable cache for status line output (default: true)',
			negatable: true,
			default: true,
		},
		refreshInterval: {
			type: 'number',
			description: `Refresh interval in seconds for cache expiry (default: ${DEFAULT_STATUSLINE_REFRESH_INTERVAL_SECONDS})`,
			default: DEFAULT_STATUSLINE_REFRESH_INTERVAL_SECONDS,
		},
		contextLowThreshold: {
			type: 'custom',
			description: 'Context usage percentage below which status is shown in green (0-100)',
			parse: value => parseContextThreshold(value),
			default: DEFAULT_CONTEXT_USAGE_THRESHOLDS.LOW,
		},
		contextMediumThreshold: {
			type: 'custom',
			description: 'Context usage percentage below which status is shown in yellow (0-100)',
			parse: value => parseContextThreshold(value),
			default: DEFAULT_CONTEXT_USAGE_THRESHOLDS.MEDIUM,
		},
		config: sharedArgs.config,
		debug: sharedArgs.debug,
	},
	async run(ctx) {
		// Set logger to silent for statusline output
		logger.level = 0;

		// Validate threshold ordering constraint: LOW must be less than MEDIUM
		if (ctx.values.contextLowThreshold >= ctx.values.contextMediumThreshold) {
			throw new Error(`Context low threshold (${ctx.values.contextLowThreshold}) must be less than medium threshold (${ctx.values.contextMediumThreshold})`);
		}

		// Load configuration and merge with CLI args
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		// Use refresh interval from merged options
		const refreshInterval = mergedOptions.refreshInterval;

		// Read input from stdin
		const stdin = await getStdin();
		if (stdin.length === 0) {
			log('❌ No input provided');
			process.exit(1);
		}

		// Parse input as JSON
		const hookDataJson: unknown = JSON.parse(stdin.trim());
		const hookDataParseResult = v.safeParse(statuslineHookJsonSchema, hookDataJson);
		if (!hookDataParseResult.success) {
			log('❌ Invalid input format:', v.flatten(hookDataParseResult.issues));
			process.exit(1);
		}
		const hookData = hookDataParseResult.output;

		// Extract session ID from hook data
		const sessionId = hookData.session_id;

		/**
		 * Read initial semaphore state for cache validation and process checking
		 * This is a snapshot taken at the beginning to avoid race conditions
		 */
		const initialSemaphoreState = Result.pipe(
			Result.succeed(getSemaphore(sessionId)),
			Result.map(semaphore => semaphore.data),
			Result.unwrap(undefined),
		);

		// Get current file modification time for cache validation and semaphore update
		const currentMtime = await getFileModifiedTime(hookData.transcript_path);

		if (mergedOptions.cache && initialSemaphoreState != null) {
			/**
			 * Time-only cache validation:
			 * Cache expires after refreshInterval seconds (default: 15s).
			 * In active sessions, transcript mtime changes constantly which caused
			 * permanent cache misses with the old hybrid (time + mtime) approach.
			 * Time-only mode ensures the cache actually works in practice.
			 */
			const now = Date.now();
			const timeElapsed = now - (initialSemaphoreState.lastUpdateTime ?? 0);
			const isExpired = timeElapsed >= refreshInterval * 1000;

			if (!isExpired) {
				// Cache is still valid, return cached output
				log(initialSemaphoreState.lastOutput);
				return;
			}

			// If another process is updating, return stale output
			if (initialSemaphoreState.isUpdating === true) {
				// Check if the updating process is still alive (optional deadlock protection)
				const pid = initialSemaphoreState.pid;
				let isProcessAlive = false;
				if (pid != null) {
					try {
						process.kill(pid, 0); // Signal 0 doesn't kill, just checks if process exists
						isProcessAlive = true;
					}
					catch {
						// Process doesn't exist, likely dead
						isProcessAlive = false;
					}
				}

				if (isProcessAlive) {
					// Another process is actively updating, return stale output
					log(initialSemaphoreState.lastOutput);
					return;
				}
				// Process is dead, continue to update ourselves
			}
		}

		// Acquisition phase: Mark as updating
		{
			const currentPid = process.pid;
			using semaphore = getSemaphore(sessionId);
			if (semaphore.data != null) {
				semaphore.data = {
					...semaphore.data,
					isUpdating: true,
					pid: currentPid,
				} as const satisfies SemaphoreType;
			}
			else {
				const currentMtimeForInit = await getFileModifiedTime(hookData.transcript_path);
				semaphore.data = {
					date: new Date().toISOString(),
					lastOutput: '',
					lastUpdateTime: 0,
					transcriptPath: hookData.transcript_path,
					transcriptMtime: currentMtimeForInit,
					isUpdating: true,
					pid: currentPid,
				} as const satisfies SemaphoreType;
			}
		}

		const mainProcessingResult = Result.pipe(
			await Result.try({
				try: async () => {
					const costSource = ctx.values.costSource;
					const today = new Date();
					const todayStr = today.toISOString().split('T')[0]?.replace(/-/g, '') ?? '';
					const sharedFetcher = createSharedPricingFetcher();

					// Load all data in parallel: statusline data + context tokens
					const [statuslineData, contextInfo] = await Promise.all([
						loadStatuslineData({ sessionId, todayStr, mode: 'auto' }, sharedFetcher),
						Result.pipe(
							Result.try({
								try: calculateContextTokens(hookData.transcript_path, hookData.model.id, sharedFetcher),
								catch: error => error,
							}),
							Result.inspectError(error => logger.debug(`Failed to calculate context tokens: ${error instanceof Error ? error.message : String(error)}`)),
							Result.map((contextResult) => {
								if (contextResult == null) {
									return undefined;
								}
								const color = contextResult.percentage < ctx.values.contextLowThreshold
									? pc.green
									: contextResult.percentage < ctx.values.contextMediumThreshold
										? pc.yellow
										: pc.red;
								const coloredPercentage = color(`${contextResult.percentage}%`);
								const tokenDisplay = contextResult.inputTokens.toLocaleString();
								return `${tokenDisplay} (${coloredPercentage})`;
							}),
							Result.unwrap(undefined),
						),
					]);

					// Determine session cost display based on cost source
					const { sessionCost, todayCost, activeBlock } = statuslineData;
					let ccCost: number | undefined;
					let betterCcusageCost: number | undefined;
					let displaySessionCost: number | undefined;

					if (costSource === 'both') {
						ccCost = hookData.cost?.total_cost_usd;
						betterCcusageCost = sessionCost;
					}
					else if (costSource === 'cc') {
						displaySessionCost = hookData.cost?.total_cost_usd;
					}
					else if (costSource === 'better-ccusage') {
						displaySessionCost = sessionCost;
					}
					else if (costSource === 'auto') {
						displaySessionCost = hookData.cost?.total_cost_usd ?? sessionCost;
					}
					else {
						unreachable(costSource);
					}

					// Format block info from active block
					const { blockInfo, burnRateInfo } = activeBlock != null
						? (() => {
								const now = new Date();
								const remaining = Math.round((activeBlock.endTime.getTime() - now.getTime()) / (1000 * 60));
								const blockCost = activeBlock.costUSD;
								const blockInfoStr = `${formatCurrency(blockCost)} block (${formatRemainingTime(remaining)})`;

								const burnRate = calculateBurnRate(activeBlock);
								const burnRateInfoStr = burnRate != null
									? (() => {
											const renderEmojiStatus = ctx.values.visualBurnRate === 'emoji' || ctx.values.visualBurnRate === 'emoji-text';
											const renderTextStatus = ctx.values.visualBurnRate === 'text' || ctx.values.visualBurnRate === 'emoji-text';
											const costPerHour = burnRate.costPerHour;
											const costPerHourStr = `${formatCurrency(costPerHour)}/hr`;

											type BurnStatus = 'normal' | 'moderate' | 'high';

											const burnStatus: BurnStatus = burnRate.tokensPerMinuteForIndicator < 2000
												? 'normal'
												: burnRate.tokensPerMinuteForIndicator < 5000
													? 'moderate'
													: 'high';

											const burnStatusMappings: Record<BurnStatus, { emoji: string; textValue: string; coloredString: Formatter }> = {
												normal: { emoji: '🟢', textValue: 'Normal', coloredString: pc.green },
												moderate: { emoji: '⚠️', textValue: 'Moderate', coloredString: pc.yellow },
												high: { emoji: '🚨', textValue: 'High', coloredString: pc.red },
											};

											const { emoji, textValue, coloredString } = burnStatusMappings[burnStatus];

											const burnRateOutputSegments: string[] = [
												coloredString(costPerHourStr),
											];

											if (renderEmojiStatus) {
												burnRateOutputSegments.push(emoji);
											}

											if (renderTextStatus) {
												burnRateOutputSegments.push(coloredString(`(${textValue})`));
											}

											return ` | 🔥 ${burnRateOutputSegments.join(' ')}`;
										})()
									: '';

								return { blockInfo: blockInfoStr, burnRateInfo: burnRateInfoStr };
							})()
						: { blockInfo: 'No active block', burnRateInfo: '' };

					// Get model display name
					const modelName = hookData.model.display_name;

					// Format and output the status line
					const sessionDisplay = (() => {
						if (ccCost != null || betterCcusageCost != null) {
							const ccDisplay = ccCost != null ? formatCurrency(ccCost) : 'N/A';
							const betterCcusageDisplay = betterCcusageCost != null ? formatCurrency(betterCcusageCost) : 'N/A';
							return `(${ccDisplay} cc / ${betterCcusageDisplay} better-ccusage)`;
						}
						return displaySessionCost != null ? formatCurrency(displaySessionCost) : 'N/A';
					})();
					const statusLine = `🤖 ${modelName} | 💰 ${sessionDisplay} session / ${formatCurrency(todayCost)} today / ${blockInfo}${burnRateInfo} | 🧠 ${contextInfo ?? 'N/A'}`;
					return statusLine;
				},
				catch: error => error,
			})(),
		);

		if (Result.isSuccess(mainProcessingResult)) {
			const statusLine = mainProcessingResult.value;
			log(statusLine);
			if (!mergedOptions.cache) {
				return;
			}
			// update semaphore with result (use mtime from cache validation time)
			using semaphore = getSemaphore(sessionId);
			semaphore.data = {
				date: new Date().toISOString(),
				lastOutput: statusLine,
				lastUpdateTime: Date.now(),
				transcriptPath: hookData.transcript_path,
				transcriptMtime: currentMtime, // Use mtime from when we started processing
				isUpdating: false,
				pid: undefined,
			};
			return;
		}

		// Handle processing result
		if (Result.isFailure(mainProcessingResult)) {
			// Reset updating flag on error to prevent deadlock

			// If we have a cached output from previous run, use it
			if (initialSemaphoreState?.lastOutput != null && initialSemaphoreState.lastOutput !== '') {
				log(initialSemaphoreState.lastOutput);
			}
			else {
				// Fallback minimal output
				log('❌ Error generating status');
			}

			logger.error('Error in statusline command:', mainProcessingResult.error);

			if (!mergedOptions.cache) {
				return;
			}

			// Release semaphore and reset updating flag
			using semaphore = getSemaphore(sessionId);
			if (semaphore.data != null) {
				semaphore.data.isUpdating = false;
				semaphore.data.pid = undefined;
			}
		}
	},
});
