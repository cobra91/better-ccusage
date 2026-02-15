import type { UsageReportConfig } from '@better-ccusage/terminal/table';
import process from 'node:process';
import { addEmptySeparatorRow, createUsageReportTable, formatTotalsRow, formatUsageDataRow, pushBreakdownRows } from '@better-ccusage/terminal/table';
import { define } from 'gunshi';
import { loadDailyUsageData } from '../data-loader.ts';
import { log, logger } from '../logger.ts';

export const dailyCommand = define({
	name: 'daily',
	description: 'Show daily usage report',
	args: {
		breakdown: {
			type: 'boolean',
			short: 'b',
			description: 'Show per-model cost breakdown',
			default: false,
		},
		compact: {
			type: 'boolean',
			description: 'Force compact mode for narrow displays',
			default: false,
		},
	},
	async run(ctx) {
		const dailyData = await loadDailyUsageData();

		if (dailyData.length === 0) {
			logger.warn('No OpenCode usage data found.');
			process.exit(0);
		}

		// Calculate totals
		const totals = {
			inputTokens: dailyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: dailyData.reduce((sum, d) => sum + d.outputTokens, 0),
			cacheCreationTokens: dailyData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: dailyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalCost: dailyData.reduce((sum, d) => sum + d.totalCost, 0),
		};

		// Print header
		logger.box('OpenCode Token Usage Report - Daily');

		// Create table
		const tableConfig: UsageReportConfig = {
			firstColumnName: 'Date',
			forceCompact: ctx.values.compact,
		};
		const table = createUsageReportTable(tableConfig);

		// Add daily data
		for (const data of dailyData) {
			const row = formatUsageDataRow(data.period, {
				source: data.source,
				inputTokens: data.inputTokens,
				outputTokens: data.outputTokens,
				cacheCreationTokens: data.cacheCreationTokens,
				cacheReadTokens: data.cacheReadTokens,
				totalCost: data.totalCost,
				modelsUsed: data.modelsUsed,
			});
			table.push(row);

			// Add model breakdown rows if flag is set
			if (ctx.values.breakdown) {
				pushBreakdownRows(table, data.modelBreakdowns);
			}
		}

		// Add empty row for visual separation before totals
		addEmptySeparatorRow(table, 9);

		// Add totals
		const totalsRow = formatTotalsRow({
			inputTokens: totals.inputTokens,
			outputTokens: totals.outputTokens,
			cacheCreationTokens: totals.cacheCreationTokens,
			cacheReadTokens: totals.cacheReadTokens,
			totalCost: totals.totalCost,
		});
		table.push(totalsRow);

		log(table.toString());

		// Show guidance message if in compact mode
		if (table.isCompactMode()) {
			logger.info('\nRunning in Compact Mode');
			logger.info('Expand terminal width to see cache metrics and total tokens');
		}
	},
});
