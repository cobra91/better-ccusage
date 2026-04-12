import type { ModelPricing } from '@better-ccusage/internal/pricing';
import { PricingFetcher } from '@better-ccusage/internal/pricing';
import { loadMergedPricing } from '@better-ccusage/internal/remote-pricing';
import { Result } from '@praha/byethrow';
import { logger } from './logger.ts';

let _sharedPricingMap: Map<string, ModelPricing> | null = null;
let _sharedPricingPromise: Promise<Map<string, ModelPricing>> | null = null;

async function getSharedPricingMap(): Promise<Map<string, ModelPricing>> {
	if (_sharedPricingPromise == null) {
		_sharedPricingPromise = (async () => {
			if (_sharedPricingMap == null) {
				_sharedPricingMap = new Map(Object.entries(await loadMergedPricing()));
			}
			return _sharedPricingMap;
		})();
	}
	return _sharedPricingPromise;
}

/**
 * Create a PricingFetcher that shares a singleton pricing Map across all instances.
 * Use this when multiple fetchers are needed in the same process (e.g. statusline).
 */
export function createSharedPricingFetcher(): CcusagePricingFetcher {
	return new CcusagePricingFetcher({
		preloadedPricing: getSharedPricingMap,
		logger,
	});
}

/**
 * Extended PricingFetcher pre-configured with merged pricing data.
 * Uses loadMergedPricing() which fetches from LiteLLM at runtime with
 * local cache (24h TTL) and static JSON fallback.
 */
export class CcusagePricingFetcher extends PricingFetcher {
	constructor(options?: ConstructorParameters<typeof PricingFetcher>[0]) {
		super({
			offlineLoader: loadMergedPricing,
			logger,
			...options,
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
		it('calculates cost for GLM-5-Turbo model', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.getModelPricing('glm-5-turbo'));
			expect(pricing).not.toBeNull();
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost).toBeGreaterThan(0);
		});
		it('calculates cost for GLM-5.1 model', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.getModelPricing('glm-5.1'));
			expect(pricing).not.toBeNull();
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost).toBeGreaterThan(0);
		});
		it('calculates cost for GLM-5V-Turbo model', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.getModelPricing('glm-5v-turbo'));
			expect(pricing).not.toBeNull();
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost).toBeGreaterThan(0);
		});

		it('shared fetchers use the same pricing Map', async () => {
			using f1 = createSharedPricingFetcher();
			using f2 = createSharedPricingFetcher();
			const p1 = await Result.unwrap(f1.fetchModelPricing());
			const p2 = await Result.unwrap(f2.fetchModelPricing());
			expect(p1).toBe(p2);
		});
	});
}
