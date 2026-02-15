import type { PricingFetcher } from '@better-ccusage/internal/pricing';
import { Result } from '@praha/byethrow';

/**
 * Model aliases for OpenCode-specific model names
 * Maps OpenCode model names to standard pricing database names
 */
const MODEL_ALIASES: Record<string, string> = {
	'gemini-3-pro-high': 'gemini-3-pro-preview',
	'gemini-2.5-pro': 'gemini-2.5-pro-preview',
};

/**
 * Loaded usage entry from OpenCode message files
 */
export type LoadedUsageEntry = {
	/** Message timestamp */
	timestamp: Date;
	/** Session ID */
	sessionId: string;
	/** Model name */
	model: string;
	/** Provider name */
	provider: string;
	/** Input tokens */
	inputTokens: number;
	/** Output tokens */
	outputTokens: number;
	/** Cache creation tokens */
	cacheCreationTokens: number;
	/** Cache read tokens */
	cacheReadTokens: number;
	/** Cost in USD */
	cost: number;
};

/**
 * Resolve model name using aliases
 * @param model - Original model name
 * @returns Resolved model name for pricing lookup
 */
export function resolveModelName(model: string): string {
	return MODEL_ALIASES[model] ?? model;
}

/**
 * Calculate cost for an entry using the pricing fetcher
 * @param entry - Usage entry with token counts
 * @param fetcher - Pricing fetcher instance
 * @returns Cost in USD
 */
export async function calculateCostForEntry(
	entry: LoadedUsageEntry,
	fetcher: PricingFetcher,
): Promise<number> {
	const modelName = resolveModelName(entry.model);

	const result = await fetcher.calculateCostFromTokens(
		{
			input_tokens: entry.inputTokens,
			output_tokens: entry.outputTokens,
			cache_creation_input_tokens: entry.cacheCreationTokens,
			cache_read_input_tokens: entry.cacheReadTokens,
		},
		modelName,
	);

	if (Result.isSuccess(result)) {
		return result.value;
	}

	// Return 0 if we can't calculate cost
	return 0;
}

if (import.meta.vitest != null) {
	describe('resolveModelName', () => {
		it('returns original name when no alias exists', () => {
			expect(resolveModelName('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-20250514');
			expect(resolveModelName('unknown-model')).toBe('unknown-model');
		});

		it('returns aliased name when alias exists', () => {
			expect(resolveModelName('gemini-3-pro-high')).toBe('gemini-3-pro-preview');
			expect(resolveModelName('gemini-2.5-pro')).toBe('gemini-2.5-pro-preview');
		});
	});
}
