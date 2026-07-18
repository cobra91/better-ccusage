import type { CliInvocation } from './cli-utils.ts';
import { z } from 'zod';
import { createCliInvocation, executeCliCommand, resolveBinaryPath } from './cli-utils.ts';

// Codex is now a source inside better-ccusage. We still expose dedicated
// codex-daily/codex-monthly tools (backed by the @better-ccusage/codex shim,
// which forwards to better-ccusage while silencing non-codex sources), so
// existing MCP clients keep working without API changes. The JSON shape now
// matches better-ccusage's Claude-model output (input/output/cache buckets).
const codexModelUsageSchema = z.object({
	modelName: z.string().optional(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	cost: z.number(),
});

const codexTotalsSchema = z.object({
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	totalCost: z.number(),
	totalTokens: z.number().optional(),
});

const codexDailyRowSchema = z.object({
	date: z.string(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	totalCost: z.number(),
	modelsUsed: z.array(z.string()).optional(),
	modelBreakdowns: z.array(codexModelUsageSchema).optional(),
});

const codexMonthlyRowSchema = z.object({
	month: z.string(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	totalCost: z.number(),
	modelsUsed: z.array(z.string()).optional(),
	modelBreakdowns: z.array(codexModelUsageSchema).optional(),
});

// Response schemas for internal parsing only - not exported
const codexDailyResponseSchema = z.object({
	daily: z.array(codexDailyRowSchema),
	totals: codexTotalsSchema.nullable(),
});

const codexMonthlyResponseSchema = z.object({
	monthly: z.array(codexMonthlyRowSchema),
	totals: codexTotalsSchema.nullable(),
});

export const codexParametersShape = {
	since: z.string().optional(),
	until: z.string().optional(),
	timezone: z.string().optional(),
	locale: z.string().optional(),
} as const satisfies Record<string, z.ZodTypeAny>;

export const codexParametersSchema = z.object(codexParametersShape);

let cachedCodexInvocation: CliInvocation | null = null;

function getCodexInvocation(): CliInvocation {
	if (cachedCodexInvocation != null) {
		return cachedCodexInvocation;
	}

	// The @better-ccusage/codex shim now forwards to better-ccusage while
	// silencing non-codex sources, so this tool returns codex-only data.
	const entryPath = resolveBinaryPath('@better-ccusage/codex', 'better-ccusage-codex');
	cachedCodexInvocation = createCliInvocation(entryPath);
	return cachedCodexInvocation;
}

/**
 * Execute the codex shim with the given command and parameters and return its
 * JSON output. The shim forwards to better-ccusage scoped to the codex source.
 *
 * @param command - The codex subcommand to run; either 'daily' or 'monthly'.
 * @param parameters - Parameters that, when present and non-empty, are appended as CLI flags:
 *   - `since` -> `--since`
 *   - `until` -> `--until`
 *   - `timezone` -> `--timezone`
 *   - `locale` -> `--locale`
 * @returns The raw JSON output from the codex shim as a string.
 */
async function runCodexCliJson(command: 'daily' | 'monthly', parameters: z.infer<typeof codexParametersSchema>): Promise<string> {
	const { executable, prefixArgs } = getCodexInvocation();
	const cliArgs: string[] = [...prefixArgs, command, '--json'];

	const since = parameters.since;
	if (since != null && since !== '') {
		cliArgs.push('--since', since);
	}
	const until = parameters.until;
	if (until != null && until !== '') {
		cliArgs.push('--until', until);
	}
	const timezone = parameters.timezone;
	if (timezone != null && timezone !== '') {
		cliArgs.push('--timezone', timezone);
	}
	const locale = parameters.locale;
	if (locale != null && locale !== '') {
		cliArgs.push('--locale', locale);
	}

	return executeCliCommand(executable, cliArgs, {}, 15000);
}

/**
 * Retrieve daily Codex usage data by invoking the codex shim.
 *
 * @param parameters - Query parameters (since, until, timezone, locale)
 * @returns Validated daily usage data
 */
export async function getCodexDaily(parameters: z.infer<typeof codexParametersSchema>) {
	const raw = await runCodexCliJson('daily', parameters);
	return codexDailyResponseSchema.parse(JSON.parse(raw));
}

/**
 * Retrieve monthly Codex usage data by invoking the codex shim.
 *
 * @param parameters - Query parameters (since, until, timezone, locale)
 * @returns Validated monthly usage data
 */
export async function getCodexMonthly(parameters: z.infer<typeof codexParametersSchema>) {
	const raw = await runCodexCliJson('monthly', parameters);
	return codexMonthlyResponseSchema.parse(JSON.parse(raw));
}
