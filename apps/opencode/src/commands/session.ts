import type { UsageReportConfig } from '@better-ccusage/terminal/table';
import process from 'node:process';
import { addEmptySeparatorRow, createUsageReportTable, formatTotalsRow, formatUsageDataRow } from '@better-ccusage/terminal/table';
import { define } from 'gunshi';
import { loadOpenCodeMessages, loadOpenCodeSessions } from '../data-loader.ts';
import { log, logger } from '../logger.ts';

export const sessionCommand = define({
	name: 'session',
	description: 'Show session-based usage report with subagent hierarchy',
	args: {
		compact: {
			type: 'boolean',
			description: 'Force compact mode for narrow displays',
			default: false,
		},
	},
	async run(ctx) {
		const [messages, sessions] = await Promise.all([
			loadOpenCodeMessages(),
			loadOpenCodeSessions(),
		]);

		if (messages.length === 0) {
			logger.warn('No OpenCode usage data found.');
			process.exit(0);
		}

		// Aggregate by session
		const sessionMap = new Map<string, {
			sessionId: string;
			description?: string;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalCost: number;
			modelsUsed: string[];
		}>();

		for (const msg of messages) {
			const existing = sessionMap.get(msg.sessionId);
			if (existing != null) {
				existing.inputTokens += msg.inputTokens;
				existing.outputTokens += msg.outputTokens;
				existing.cacheCreationTokens += msg.cacheCreationTokens;
				existing.cacheReadTokens += msg.cacheReadTokens;
				existing.totalCost += msg.cost;
				if (!existing.modelsUsed.includes(msg.model)) {
					existing.modelsUsed.push(msg.model);
				}
			}
			else {
				sessionMap.set(msg.sessionId, {
					sessionId: msg.sessionId,
					inputTokens: msg.inputTokens,
					outputTokens: msg.outputTokens,
					cacheCreationTokens: msg.cacheCreationTokens,
					cacheReadTokens: msg.cacheReadTokens,
					totalCost: msg.cost,
					modelsUsed: [msg.model],
				});
			}
		}

		// Get session descriptions
		const sessionDescriptions = new Map<string, string>();
		function collectDescriptions(sessionList: typeof sessions, depth = 0): void {
			for (const session of sessionList) {
				const desc = session.description ?? `Session ${session.id.slice(0, 8)}`;
				sessionDescriptions.set(session.id, depth > 0 ? `${'  '.repeat(depth)}└─ ${desc}` : desc);
				if (session.children.length > 0) {
					collectDescriptions(session.children, depth + 1);
				}
			}
		}
		collectDescriptions(sessions);

		// Convert to array and sort
		const sessionData = Array.from(sessionMap.values())
			.map(s => ({
				...s,
				description: sessionDescriptions.get(s.sessionId) ?? s.sessionId.slice(0, 8),
			}))
			.sort((a, b) => a.sessionId.localeCompare(b.sessionId));

		// Calculate totals
		const totals = {
			inputTokens: sessionData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: sessionData.reduce((sum, d) => sum + d.outputTokens, 0),
			cacheCreationTokens: sessionData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: sessionData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalCost: sessionData.reduce((sum, d) => sum + d.totalCost, 0),
		};

		// Print header
		logger.box('OpenCode Token Usage Report - Session');

		// Create table
		const tableConfig: UsageReportConfig = {
			firstColumnName: 'Session',
			forceCompact: ctx.values.compact,
		};
		const table = createUsageReportTable(tableConfig);

		// Add session data
		for (const data of sessionData) {
			const row = formatUsageDataRow(data.description, {
				source: 'opencode',
				inputTokens: data.inputTokens,
				outputTokens: data.outputTokens,
				cacheCreationTokens: data.cacheCreationTokens,
				cacheReadTokens: data.cacheReadTokens,
				totalCost: data.totalCost,
				modelsUsed: data.modelsUsed,
			});
			table.push(row);
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
