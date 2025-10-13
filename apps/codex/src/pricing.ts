import type { ModelPricing as InternalModelPricing } from '@better-ccusage/internal/pricing';
import type { ModelPricing, PricingSource } from './_types.ts';
import { PricingFetcher } from '@better-ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { MILLION } from './_consts.ts';
import { prefetchCodexPricing } from './_macro.ts' with { type: 'macro' };
import { logger } from './logger.ts';

const CODEX_PROVIDER_PREFIXES = ['openai/', 'azure/', 'openrouter/openai/'];
const CODEX_MODEL_ALIASES_MAP = new Map<string, string>([
	['gpt-5-codex', 'gpt-5'],
]);

/**
 * Convert a per-token cost to its per-million (per M tokens) equivalent.
 *
 * If `value` is undefined, `fallback` is used; if both are undefined, zero is used.
 *
 * @param value - The per-token value to convert
 * @param fallback - Fallback per-token value used when `value` is undefined
 * @returns The per-million equivalent of the chosen per-token value
 */
function toPerMillion(value: number | undefined, fallback?: number): number {
	const perToken = value ?? fallback ?? 0;
	return perToken * MILLION;
}

export type CodexPricingSourceOptions = {
	offlineLoader?: () => Promise<Record<string, InternalModelPricing>>;
};

const PREFETCHED_CODEX_PRICING = prefetchCodexPricing();

export class CodexPricingSource implements PricingSource, Disposable {
	private readonly fetcher: PricingFetcher;

	constructor(options: CodexPricingSourceOptions = {}) {
		this.fetcher = new PricingFetcher({
			offlineLoader: options.offlineLoader ?? (async () => PREFETCHED_CODEX_PRICING),
			logger,
			providerPrefixes: CODEX_PROVIDER_PREFIXES,
		});
	}

	[Symbol.dispose](): void {
		this.fetcher[Symbol.dispose]();
	}

	async getPricing(model: string): Promise<ModelPricing> {
		const directLookup = await this.fetcher.getModelPricing(model);
		if (Result.isFailure(directLookup)) {
			throw directLookup.error;
		}

		let pricing = directLookup.value;
		if (pricing == null) {
			const alias = CODEX_MODEL_ALIASES_MAP.get(model);
			if (alias != null) {
				const aliasLookup = await this.fetcher.getModelPricing(alias);
				if (Result.isFailure(aliasLookup)) {
					throw aliasLookup.error;
				}
				pricing = aliasLookup.value;
			}
		}

		if (pricing == null) {
			throw new Error(`Pricing not found for model ${model}`);
		}

		return {
			inputCostPerMToken: toPerMillion(pricing.input_cost_per_token),
			cachedInputCostPerMToken: toPerMillion(pricing.cache_read_input_token_cost, pricing.input_cost_per_token),
			outputCostPerMToken: toPerMillion(pricing.output_cost_per_token),
		};
	}
}

if (import.meta.vitest != null) {
	describe('CodexPricingSource', () => {
		it('converts model pricing to per-million costs', async () => {
			using source = new CodexPricingSource({
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1.25e-6,
						output_cost_per_token: 1e-5,
						cache_read_input_token_cost: 1.25e-7,
					},
				}),
			});

			const pricing = await source.getPricing('gpt-5-codex');
			expect(pricing.inputCostPerMToken).toBeCloseTo(1.25);
			expect(pricing.outputCostPerMToken).toBeCloseTo(10);
			expect(pricing.cachedInputCostPerMToken).toBeCloseTo(0.125);
		});
	});
}