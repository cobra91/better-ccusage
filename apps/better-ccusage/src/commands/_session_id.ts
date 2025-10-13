import type { CostMode } from '../_types.ts';
import type { UsageData } from '../data-loader.ts';
import process from 'node:process';
import { formatCurrency, formatNumber, ResponsiveTable } from '@better-ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { formatDateCompact } from '../_date-utils.ts';
import { processWithJq } from '../_jq-processor.ts';
import { loadSessionUsageById } from '../data-loader.ts';
import { log, logger } from '../logger.ts';

export type SessionIdContext = {
	values: {
		id: string;
		mode: CostMode;
		jq?: string;
		timezone?: string;
		locale: string; // normalized to non-optional to avoid touching data-loader
	};
};

/**
 * Look up usage for a session ID and print either JSON output or a human-readable table.
 *
 * When no session is found this will print `null` (if `useJson`), or log a warning, and then exit the process with code 0.
 * If a `jq` filter is provided in `ctx.values.jq`, the JSON output will be processed with `jq`; jq processing errors are logged and the process exits with code 1.
 *
 * @param ctx - Context containing the session `id`, `mode`, optional `jq`, `timezone`, and required `locale` used for loading and formatting the session usage
 * @param useJson - If `true`, emit structured JSON (optionally filtered by `jq`); if `false`, emit a formatted human-readable table
 */
export async function handleSessionIdLookup(ctx: SessionIdContext, useJson: boolean): Promise<void> {
	const sessionUsage = await loadSessionUsageById(ctx.values.id, {
		mode: ctx.values.mode,
	});

	if (sessionUsage == null) {
		if (useJson) {
			log(JSON.stringify(null));
		}
		else {
			logger.warn(`No session found with ID: ${ctx.values.id}`);
		}
		process.exit(0);
	}

	if (useJson) {
		const jsonOutput = {
			sessionId: ctx.values.id,
			totalCost: sessionUsage.totalCost,
			totalTokens: calculateSessionTotalTokens(sessionUsage.entries),
			entries: sessionUsage.entries.map(entry => ({
				timestamp: entry.timestamp,
				inputTokens: entry.message.usage.input_tokens,
				outputTokens: entry.message.usage.output_tokens,
				cacheCreationTokens: entry.message.usage.cache_creation_input_tokens ?? 0,
				cacheReadTokens: entry.message.usage.cache_read_input_tokens ?? 0,
				model: entry.message.model ?? 'unknown',
				costUSD: entry.costUSD ?? 0,
			})),
		};

		if (ctx.values.jq != null) {
			const jqResult = await processWithJq(jsonOutput, ctx.values.jq);
			if (Result.isFailure(jqResult)) {
				logger.error(jqResult.error.message);
				process.exit(1);
			}
			log(jqResult.value);
		}
		else {
			log(JSON.stringify(jsonOutput, null, 2));
		}
	}
	else {
		logger.box(`Claude Code Session Usage - ${ctx.values.id}`);

		const totalTokens = calculateSessionTotalTokens(sessionUsage.entries);

		log(`Total Cost: ${formatCurrency(sessionUsage.totalCost)}`);
		log(`Total Tokens: ${formatNumber(totalTokens)}`);
		log(`Total Entries: ${sessionUsage.entries.length}`);
		log('');

		if (sessionUsage.entries.length > 0) {
			const table = new ResponsiveTable({
				head: [
					'Timestamp',
					'Model',
					'Input',
					'Output',
					'Cache Create',
					'Cache Read',
					'Cost (USD)',
				],
				style: { head: ['cyan'] },
				colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right'],
			});

			for (const entry of sessionUsage.entries) {
				table.push([
					formatDateCompact(entry.timestamp, ctx.values.timezone, ctx.values.locale),
					entry.message.model ?? 'unknown',
					formatNumber(entry.message.usage.input_tokens),
					formatNumber(entry.message.usage.output_tokens),
					formatNumber(entry.message.usage.cache_creation_input_tokens ?? 0),
					formatNumber(entry.message.usage.cache_read_input_tokens ?? 0),
					formatCurrency(entry.costUSD ?? 0),
				]);
			}

			log(table.toString());
		}
	}
}

function calculateSessionTotalTokens(entries: UsageData[]): number {
	return entries.reduce((sum, entry) => {
		const usage = entry.message.usage;
		return (
			sum
			+ usage.input_tokens
			+ usage.output_tokens
			+ (usage.cache_creation_input_tokens ?? 0)
			+ (usage.cache_read_input_tokens ?? 0)
		);
	}, 0);
}