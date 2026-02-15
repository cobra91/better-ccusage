import type { UsageReportConfig } from '@better-ccusage/terminal/table';
import process from 'node:process';
import { addEmptySeparatorRow, createUsageReportTable, formatTotalsRow, formatUsageDataRow, pushBreakdownRows } from '@better-ccusage/terminal/table';
import { define } from 'gunshi';
import { loadWeeklyUsageData } from '../data-loader.ts';
import { log, logger } from '../logger.ts';

export const weeklyCommand = define({
	name: 'weekly',
	description: 'Show weekly usage report (ISO week format: YYYY-Www)',
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
		const weeklyData = await loadWeeklyUsageData();

		if (weeklyData.length === 0) {
			logger.warn('No OpenCode usage data found.');
			process.exit(0);
		}

		// Calculate totals
		const totals = {
			inputTokens: weeklyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: weeklyData.reduce((sum, d) => sum + d.outputTokens, 0),
			cacheCreationTokens: weeklyData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: weeklyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalCost: weeklyData.reduce((sum, d) => sum + d.totalCost, 0),
		};

		// Print header
		logger.box('OpenCode Token Usage Report - Weekly');

		// Create table
		const tableConfig: UsageReportConfig = {
			firstColumnName: 'Week',
			forceCompact: ctx.values.compact,
		};
		const table = createUsageReportTable(tableConfig);

		// Add weekly data
		for (const data of weeklyData) {
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
