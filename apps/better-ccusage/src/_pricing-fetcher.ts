import type { ModelPricing } from '@better-ccusage/internal/pricing';
import { PricingFetcher } from '@better-ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { prefetchClaudePricing, prefetchGLMPricing } from './_macro.ts' with { type: 'macro' };
import { logger } from './logger.ts';

const CCUSAGE_PROVIDER_PREFIXES = [
	'anthropic/',
	'claude-3-5-',
	'claude-3-',
	'claude-',
	'openrouter/openai/',
	'zai/',
	'deepseek/',
	'dashscope/',
];

const PREFETCHED_CLAUDE_PRICING = prefetchClaudePricing();
const PREFETCHED_GLM_PRICING = prefetchGLMPricing();

/**
 * Combine prefetched Claude and GLM model pricing into a single lookup object.
 *
 * Merges the two prefetched pricing maps into one Record keyed by model identifier.
 *
 * @returns A mapping from model identifier to `ModelPricing`; when the same key exists in both sources, the GLM entry overrides the Claude entry.
 */
async function prefetchCcusagePricing(): Promise<Record<string, ModelPricing>> {
	const [claudePricing, glmPricing] = await Promise.all([
		PREFETCHED_CLAUDE_PRICING,
		PREFETCHED_GLM_PRICING,
	]);

	return {
		...claudePricing,
		...glmPricing,
	};
}

export class CcusagePricingFetcher extends PricingFetcher {
	constructor() {
		super({
			offlineLoader: async () => prefetchCcusagePricing(),
			logger,
			providerPrefixes: CCUSAGE_PROVIDER_PREFIXES,
		});
	}
}

if (import.meta.vitest != null) {
	describe('PricingFetcher', () => {
		it('loads pricing data successfully', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.fetchModelPricing());
			expect(pricing.size).toBeGreaterThan(0);
		});

		it('calculates cost for Claude model tokens', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.getModelPricing('claude-sonnet-4-20250514'));
			expect(pricing).not.toBeNull();
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost).toBeGreaterThan(0);
		});

		it('calculates cost for claude-sonnet-4-5-20250929 model tokens', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.getModelPricing('claude-sonnet-4-5-20250929'));
			expect(pricing).not.toBeNull();
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost).toBeGreaterThan(0);
		});

		it('calculates cost for GLM-4.5 model tokens', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.getModelPricing('glm-4.5'));
			expect(pricing).not.toBeNull();
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost).toBeGreaterThan(0);
		});

		it('calculates cost for GLM-4.5 model with provider prefix', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.getModelPricing('zai/glm-4.5'));
			expect(pricing).not.toBeNull();
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost).toBeGreaterThan(0);
		});

		it('calculates cost for GLM-4.5-Air model', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.getModelPricing('glm-4.5-air'));
			expect(pricing).not.toBeNull();
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost).toBeGreaterThan(0);
		});
	});
}