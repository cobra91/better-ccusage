import { Result } from '@praha/byethrow';
import * as v from 'valibot';

/**
 * Default token threshold for tiered pricing in 1M context window models.
 * The pricing schema hard-codes this threshold in field names
 * (e.g., `input_cost_per_token_above_200k_tokens`).
 * The threshold parameter in calculateTieredCost allows flexibility for
 * future models that may use different thresholds.
 */
const DEFAULT_TIERED_THRESHOLD = 200_000;

/**
 * Model Pricing Schema
 *
 * ⚠️ TIERED PRICING NOTE:
 * Different models use different token thresholds for tiered pricing:
 * - Claude/Anthropic: 200k tokens (implemented in calculateTieredCost)
 * - Gemini: 128k tokens (schema fields only, NOT implemented in calculations)
 * - GPT/OpenAI: No tiered pricing (flat rate)
 *
 * When adding support for new models:
 * 1. Check if model has tiered pricing in pricing data
 * 2. Verify the threshold value
 * 3. Update calculateTieredCost logic if threshold differs from 200k
 * 4. Add tests for tiered pricing boundaries
 */
export type TieredPricingConfig = {
	input_cost_per_token: number;
	output_cost_per_token: number;
	range: [number, number];
	cache_read_input_token_cost?: number;
};

export const modelPricingSchema = v.object({
	input_cost_per_token: v.optional(v.number()),
	output_cost_per_token: v.optional(v.number()),
	cache_creation_input_token_cost: v.optional(v.number()),
	cache_read_input_token_cost: v.optional(v.number()),
	max_tokens: v.optional(v.number()),
	max_input_tokens: v.optional(v.number()),
	max_output_tokens: v.optional(v.number()),
	// Claude/Anthropic: 1M context window pricing (200k threshold)
	input_cost_per_token_above_200k_tokens: v.optional(v.number()),
	output_cost_per_token_above_200k_tokens: v.optional(v.number()),
	cache_creation_input_token_cost_above_200k_tokens: v.optional(v.number()),
	cache_read_input_token_cost_above_200k_tokens: v.optional(v.number()),
	// Gemini: Tiered pricing (128k threshold) - NOT implemented in calculations
	input_cost_per_token_above_128k_tokens: v.optional(v.number()),
	output_cost_per_token_above_128k_tokens: v.optional(v.number()),
	tiered_pricing: v.optional(v.array(v.object({
		input_cost_per_token: v.number(),
		output_cost_per_token: v.number(),
		range: v.tuple([v.number(), v.number()]),
		cache_read_input_token_cost: v.optional(v.number()),
	}))),
});

export type ModelPricing = v.InferOutput<typeof modelPricingSchema>;

export type PricingLogger = {
	debug: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
};

export type PricingFetcherOptions = {
	logger?: PricingLogger;
	offlineLoader: () => Promise<Record<string, ModelPricing>>;
	providerPrefixes?: string[];
};

const DEFAULT_PROVIDER_PREFIXES = [
	'anthropic/',
	'claude-3-5-',
	'claude-3-',
	'claude-',
	'openai/',
	'azure/',
	'openrouter/openai/',
	'zai/',
	'streamlake/',
];

function createLogger(logger?: PricingLogger): PricingLogger {
	if (logger != null) {
		return logger;
	}

	return {
		debug: () => {},
		error: () => {},
		info: () => {},
		warn: () => {},
	};
}

export class PricingFetcher implements Disposable {
	private cachedPricing: Map<string, ModelPricing> | null = null;
	private readonly logger: PricingLogger;
	private readonly offlineLoader: () => Promise<Record<string, ModelPricing>>;
	private readonly providerPrefixes: string[];

	constructor(options: PricingFetcherOptions) {
		this.logger = createLogger(options.logger);
		this.offlineLoader = options.offlineLoader;
		this.providerPrefixes = options.providerPrefixes ?? DEFAULT_PROVIDER_PREFIXES;
	}

	[Symbol.dispose](): void {
		this.clearCache();
	}

	clearCache(): void {
		this.cachedPricing = null;
	}

	private async ensurePricingLoaded(): Result.ResultAsync<Map<string, ModelPricing>, Error> {
		if (this.cachedPricing != null) {
			return Result.succeed(this.cachedPricing);
		}

		return Result.pipe(
			Result.try({
				try: async () => {
					const pricing = new Map(Object.entries(await this.offlineLoader()));
					this.cachedPricing = pricing;
					return pricing;
				},
				catch: error => new Error('Failed to load pricing data', { cause: error }),
			})(),
			Result.inspect((pricing) => {
				this.logger.info(`Loaded pricing for ${pricing.size} models`);
			}),
		);
	}

	async fetchModelPricing(): Result.ResultAsync<Map<string, ModelPricing>, Error> {
		return this.ensurePricingLoaded();
	}

	private createMatchingCandidates(modelName: string): string[] {
		const candidates = new Set<string>();
		candidates.add(modelName);

		for (const prefix of this.providerPrefixes) {
			candidates.add(`${prefix}${modelName}`);
		}

		return Array.from(candidates);
	}

	async getModelPricing(modelName: string): Result.ResultAsync<ModelPricing | null, Error> {
		return Result.pipe(
			this.ensurePricingLoaded(),
			Result.map((pricing) => {
				for (const candidate of this.createMatchingCandidates(modelName)) {
					const direct = pricing.get(candidate);
					if (direct != null) {
						return direct;
					}
				}

				const lower = modelName.toLowerCase();

				// Try exact model name match first (highest priority)
				for (const [key, value] of pricing) {
					const comparison = key.toLowerCase();
					if (comparison === lower || comparison.endsWith(`/${lower}`)) {
						return value;
					}
				}

				// Try partial match but prioritize models that contain the full model name
				let bestMatch = null;
				let bestMatchScore = 0;

				for (const [key, value] of pricing) {
					const comparison = key.toLowerCase();

					// Score matches: exact substring gets higher score
					let score = 0;
					if (comparison.includes(lower)) {
						// Higher score for exact model name without "air" suffix
						if (comparison.includes(`${lower}/`) || comparison.endsWith(`/${lower}`)) {
							score = 100; // Exact model name as provider/model
						}
						else if (comparison.includes(lower) && !comparison.includes('air')) {
							// Extra priority for zai provider (main GLM models)
							if (comparison.startsWith('zai/')) {
								score = 95; // zai provider models get highest priority
							}
							else {
								score = 90; // Contains model name, not air variant
							}
						}
						else if (comparison.includes(lower)) {
							score = 50; // Contains model name but might be air variant
						}
					}
					else if (lower.includes(comparison)) {
						score = 10; // Partial match
					}

					if (score > bestMatchScore) {
						bestMatch = value;
						bestMatchScore = score;
					}
				}

				if (bestMatch !== null) {
					return bestMatch;
				}

				return null;
			}),
		);
	}

	async getModelContextLimit(modelName: string): Result.ResultAsync<number | null, Error> {
		return Result.pipe(
			this.getModelPricing(modelName),
			Result.map(pricing => pricing?.max_input_tokens ?? null),
		);
	}

	/**
	 * Calculate the total cost for token usage based on model pricing
	 *
	 * Supports tiered pricing for 1M context window models where tokens
	 * above a threshold (default 200k) are charged at a different rate.
	 * Also supports input length-based tiered pricing with custom ranges.
	 * Handles all token types: input, output, cache creation, and cache read.
	 *
	 * @param tokens - Token counts for different types
	 * @param tokens.input_tokens - Number of input tokens
	 * @param tokens.output_tokens - Number of output tokens
	 * @param tokens.cache_creation_input_tokens - Number of cache creation input tokens
	 * @param tokens.cache_read_input_tokens - Number of cache read input tokens
	 * @param pricing - Model pricing information
	 * @returns Total cost in USD
	 */
	calculateCostFromPricing(
		tokens: {
			input_tokens: number;
			output_tokens: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		},
		pricing: ModelPricing,
	): number {
		/**
		 * Calculate cost with tiered pricing for 1M context window models
		 *
		 * @param totalTokens - Total number of tokens to calculate cost for
		 * @param basePrice - Price per token for tokens up to the threshold
		 * @param tieredPrice - Price per token for tokens above the threshold
		 * @param threshold - Token threshold for tiered pricing (default 200k)
		 * @returns Total cost applying tiered pricing when applicable
		 *
		 * @example
		 * // 300k tokens with base price $3/M and tiered price $6/M
		 * calculateTieredCost(300_000, 3e-6, 6e-6)
		 * // Returns: (200_000 * 3e-6) + (100_000 * 6e-6) = $1.2
		 */
		const calculateTieredCost = (
			totalTokens: number | undefined,
			basePrice: number | undefined,
			tieredPrice: number | undefined,
			threshold: number = DEFAULT_TIERED_THRESHOLD,
		): number => {
			if (totalTokens == null || totalTokens <= 0) {
				return 0;
			}

			if (totalTokens > threshold && tieredPrice != null) {
				const tokensBelowThreshold = Math.min(totalTokens, threshold);
				const tokensAboveThreshold = Math.max(0, totalTokens - threshold);

				let tieredCost = tokensAboveThreshold * tieredPrice;
				if (basePrice != null) {
					tieredCost += tokensBelowThreshold * basePrice;
				}
				return tieredCost;
			}

			if (basePrice != null) {
				return totalTokens * basePrice;
			}

			return 0;
		};

		/**
		 * Calculate cost with input length-based tiered pricing
		 * Supports multiple custom ranges as defined in tiered_pricing array
		 *
		 * @param totalInputTokens - Total number of input tokens (used to determine tier)
		 * @param outputTokens - Number of output tokens
		 * @param cacheReadTokens - Number of cache read tokens
		 * @param baseInputPrice - Base input price per token
		 * @param baseOutputPrice - Base output price per token
		 * @param tieredPricing - Array of tiered pricing configurations with ranges
		 * @returns Total cost applying input length-based tiered pricing
		 */
		const calculateInputLengthTieredCost = (
			totalInputTokens: number,
			outputTokens: number,
			cacheReadTokens: number,
			baseInputPrice: number | undefined,
			baseOutputPrice: number | undefined,
			tieredPricing?: Array<{
				input_cost_per_token: number;
				output_cost_per_token: number;
				range: [number, number];
				cache_read_input_token_cost?: number;
			}>,
		): { inputCost: number; outputCost: number; cacheReadCost: number } => {
			if (totalInputTokens <= 0) {
				return { inputCost: 0, outputCost: 0, cacheReadCost: 0 };
			}

			// If no tiered pricing is defined, use base pricing
			if (tieredPricing == null || tieredPricing.length === 0) {
				const inputCost = baseInputPrice != null ? totalInputTokens * baseInputPrice : 0;
				const outputCost = baseOutputPrice != null ? outputTokens * baseOutputPrice : 0;
				return { inputCost, outputCost, cacheReadCost: 0 };
			}

			// Find the appropriate tier based on input token count
			let applicableTier = tieredPricing[0]; // Default to first tier
			for (const tier of tieredPricing) {
				const [minRange, maxRange] = tier.range;
				if (totalInputTokens >= minRange && totalInputTokens <= maxRange) {
					applicableTier = tier;
					break;
				}
			}

			// Ensure applicableTier is never undefined
			if (applicableTier == null) {
				applicableTier = tieredPricing[0] ?? {
					input_cost_per_token: baseInputPrice ?? 0,
					output_cost_per_token: baseOutputPrice ?? 0,
					range: [0, Infinity],
				};
			}

			return {
				inputCost: totalInputTokens * applicableTier.input_cost_per_token,
				outputCost: outputTokens * applicableTier.output_cost_per_token,
				cacheReadCost: cacheReadTokens * (applicableTier.cache_read_input_token_cost ?? 0),
			};
		};

		// Check if we have tiered_pricing array in the pricing object
		const hasTieredPricing = Array.isArray(pricing.tiered_pricing);

		if (hasTieredPricing) {
			// Use input length-based tiered pricing
			const tieredResult = calculateInputLengthTieredCost(
				tokens.input_tokens,
				tokens.output_tokens,
				tokens.cache_read_input_tokens ?? 0,
				pricing.input_cost_per_token,
				pricing.output_cost_per_token,
				pricing.tiered_pricing,
			);

			const cacheCreationCost = calculateTieredCost(
				tokens.cache_creation_input_tokens,
				pricing.cache_creation_input_token_cost,
				pricing.cache_creation_input_token_cost_above_200k_tokens,
			);

			const cacheReadCost = calculateTieredCost(
				tokens.cache_read_input_tokens,
				pricing.cache_read_input_token_cost,
				pricing.cache_read_input_token_cost_above_200k_tokens,
			);

			return tieredResult.inputCost + tieredResult.outputCost + cacheCreationCost + cacheReadCost;
		}

		// Use existing tiered pricing logic for backward compatibility
		const inputCost = calculateTieredCost(
			tokens.input_tokens,
			pricing.input_cost_per_token,
			pricing.input_cost_per_token_above_200k_tokens,
		);

		const outputCost = calculateTieredCost(
			tokens.output_tokens,
			pricing.output_cost_per_token,
			pricing.output_cost_per_token_above_200k_tokens,
		);

		const cacheCreationCost = calculateTieredCost(
			tokens.cache_creation_input_tokens,
			pricing.cache_creation_input_token_cost,
			pricing.cache_creation_input_token_cost_above_200k_tokens,
		);

		const cacheReadCost = calculateTieredCost(
			tokens.cache_read_input_tokens,
			pricing.cache_read_input_token_cost,
			pricing.cache_read_input_token_cost_above_200k_tokens,
		);

		return inputCost + outputCost + cacheCreationCost + cacheReadCost;
	}

	async calculateCostFromTokens(
		tokens: {
			input_tokens: number;
			output_tokens: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		},
		modelName?: string,
	): Result.ResultAsync<number, Error> {
		if (modelName == null || modelName === '') {
			return Result.succeed(0);
		}

		return Result.pipe(
			this.getModelPricing(modelName),
			Result.andThen((pricing) => {
				if (pricing == null) {
					return Result.fail(new Error(`Model pricing not found for ${modelName}`));
				}
				return Result.succeed(
					this.calculateCostFromPricing(tokens, pricing),
				);
			}),
		);
	}
}

if (import.meta.vitest != null) {
	describe('PricingFetcher', () => {
		it('returns pricing data from model pricing dataset', async () => {
			using fetcher = new PricingFetcher({
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1.25e-6,
						output_cost_per_token: 1e-5,
						cache_read_input_token_cost: 1.25e-7,
					},
				}),
			});

			const pricing = await Result.unwrap(fetcher.fetchModelPricing());
			expect(pricing.size).toBe(1);
		});

		it('calculates cost using pricing information', async () => {
			using fetcher = new PricingFetcher({
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1.25e-6,
						output_cost_per_token: 1e-5,
						cache_read_input_token_cost: 1.25e-7,
					},
				}),
			});

			const cost = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 200,
			}, 'gpt-5'));

			expect(cost).toBeCloseTo((1000 * 1.25e-6) + (500 * 1e-5) + (200 * 1.25e-7));
		});

		it('calculates tiered pricing for tokens exceeding 200k threshold (300k input, 250k output, 300k cache creation, 250k cache read)', async () => {
			using fetcher = new PricingFetcher({
				offlineLoader: async () => ({
					'anthropic/claude-4-sonnet-20250514': {
						input_cost_per_token: 3e-6,
						output_cost_per_token: 1.5e-5,
						input_cost_per_token_above_200k_tokens: 6e-6,
						output_cost_per_token_above_200k_tokens: 2.25e-5,
						cache_creation_input_token_cost: 3.75e-6,
						cache_read_input_token_cost: 3e-7,
						cache_creation_input_token_cost_above_200k_tokens: 7.5e-6,
						cache_read_input_token_cost_above_200k_tokens: 6e-7,
					},
				}),
			});

			// Test comprehensive scenario with all token types above 200k threshold
			const cost = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 300_000,
				output_tokens: 250_000,
				cache_creation_input_tokens: 300_000,
				cache_read_input_tokens: 250_000,
			}, 'anthropic/claude-4-sonnet-20250514'));

			const expectedCost
				= (200_000 * 3e-6) + (100_000 * 6e-6) // input
					+ (200_000 * 1.5e-5) + (50_000 * 2.25e-5) // output
					+ (200_000 * 3.75e-6) + (100_000 * 7.5e-6) // cache creation
					+ (200_000 * 3e-7) + (50_000 * 6e-7); // cache read
			expect(cost).toBeCloseTo(expectedCost);
		});

		it('uses standard pricing for 300k/250k tokens when model lacks tiered pricing', async () => {
			using fetcher = new PricingFetcher({
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 2e-6,
					},
				}),
			});

			// Should use normal pricing for all tokens
			const cost = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 300_000,
				output_tokens: 250_000,
			}, 'gpt-5'));

			expect(cost).toBeCloseTo((300_000 * 1e-6) + (250_000 * 2e-6));
		});

		it('correctly applies pricing at 200k boundary (200k uses base, 200,001 uses tiered, 0 returns 0)', async () => {
			using fetcher = new PricingFetcher({
				offlineLoader: async () => ({
					'claude-4-sonnet-20250514': {
						input_cost_per_token: 3e-6,
						input_cost_per_token_above_200k_tokens: 6e-6,
					},
				}),
			});

			// Test with exactly 200k tokens (should use only base price)
			const cost200k = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 200_000,
				output_tokens: 0,
			}, 'claude-4-sonnet-20250514'));
			expect(cost200k).toBeCloseTo(200_000 * 3e-6);

			// Test with 200,001 tokens (should use tiered pricing for 1 token)
			const cost200k1 = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 200_001,
				output_tokens: 0,
			}, 'claude-4-sonnet-20250514'));
			expect(cost200k1).toBeCloseTo((200_000 * 3e-6) + (1 * 6e-6));

			// Test with 0 tokens (should return 0)
			const costZero = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 0,
				output_tokens: 0,
			}, 'claude-4-sonnet-20250514'));
			expect(costZero).toBe(0);
		});

		it('charges only for tokens above 200k when base price is missing (300k→100k charged, 100k→0 charged)', async () => {
			using fetcher = new PricingFetcher({
				offlineLoader: async () => ({
					'theoretical-model': {
						// No base price, only tiered pricing
						input_cost_per_token_above_200k_tokens: 6e-6,
						output_cost_per_token_above_200k_tokens: 2.25e-5,
					},
				}),
			});

			// Test with 300k tokens - should only charge for tokens above 200k
			const cost = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 300_000,
				output_tokens: 250_000,
			}, 'theoretical-model'));

			// Only 100k input tokens above 200k are charged
			// Only 50k output tokens above 200k are charged
			expect(cost).toBeCloseTo((100_000 * 6e-6) + (50_000 * 2.25e-5));

			// Test with tokens below threshold - should return 0 (no base price)
			const costBelow = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 100_000,
				output_tokens: 100_000,
			}, 'theoretical-model'));
			expect(costBelow).toBe(0);
		});

		// Tests for input length-based tiered pricing
		it('calculates cost using input length-based tiered pricing for KAT-Coder-Pro V1 tier 1 (0-32K tokens)', async () => {
			using fetcher = new PricingFetcher({
				offlineLoader: async () => ({
					'kat-coder-pro-v1': {
						input_cost_per_token: 6e-7,
						output_cost_per_token: 2.4e-6,
						cache_read_input_token_cost: 1.2e-7,
						tiered_pricing: [
							{
								input_cost_per_token: 6e-7,
								output_cost_per_token: 2.4e-6,
								range: [0, 32000],
								cache_read_input_token_cost: 1.2e-7,
							},
							{
								input_cost_per_token: 9e-7,
								output_cost_per_token: 3.6e-6,
								range: [32000, 128000],
								cache_read_input_token_cost: 1.8e-7,
							},
							{
								input_cost_per_token: 1.5e-6,
								output_cost_per_token: 6e-6,
								range: [128000, 256000],
								cache_read_input_token_cost: 3e-7,
							},
						],
					},
				}),
			});

			// Test with 15,000 tokens (should use tier 1)
			const cost = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 15000,
				output_tokens: 5000,
				cache_read_input_tokens: 2000,
			}, 'kat-coder-pro-v1'));

			const expectedCost = 0.02124;
			expect(cost).toBeCloseTo(expectedCost);
		});

		it('calculates cost using input length-based tiered pricing for KAT-Coder-Pro V1 tier 2 (32-128K tokens)', async () => {
			using fetcher = new PricingFetcher({
				offlineLoader: async () => ({
					'kat-coder-pro-v1': {
						input_cost_per_token: 6e-7,
						output_cost_per_token: 2.4e-6,
						cache_read_input_token_cost: 1.2e-7,
						tiered_pricing: [
							{
								input_cost_per_token: 6e-7,
								output_cost_per_token: 2.4e-6,
								range: [0, 32000],
								cache_read_input_token_cost: 1.2e-7,
							},
							{
								input_cost_per_token: 9e-7,
								output_cost_per_token: 3.6e-6,
								range: [32000, 128000],
								cache_read_input_token_cost: 1.8e-7,
							},
							{
								input_cost_per_token: 1.5e-6,
								output_cost_per_token: 6e-6,
								range: [128000, 256000],
								cache_read_input_token_cost: 3e-7,
							},
						],
					},
				}),
			});

			// Test with 50,000 tokens (should use tier 2)
			const cost = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 50000,
				output_tokens: 10000,
				cache_read_input_tokens: 5000,
			}, 'kat-coder-pro-v1'));

			const expectedCost = 0.08189999999999999;
			expect(cost).toBeCloseTo(expectedCost);
		});

		it('calculates cost using input length-based tiered pricing for KAT-Coder-Pro V1 tier 3 (128-256K tokens)', async () => {
			using fetcher = new PricingFetcher({
				offlineLoader: async () => ({
					'kat-coder-pro-v1': {
						input_cost_per_token: 6e-7,
						output_cost_per_token: 2.4e-6,
						cache_read_input_token_cost: 1.2e-7,
						tiered_pricing: [
							{
								input_cost_per_token: 6e-7,
								output_cost_per_token: 2.4e-6,
								range: [0, 32000],
								cache_read_input_token_cost: 1.2e-7,
							},
							{
								input_cost_per_token: 9e-7,
								output_cost_per_token: 3.6e-6,
								range: [32000, 128000],
								cache_read_input_token_cost: 1.8e-7,
							},
							{
								input_cost_per_token: 1.5e-6,
								output_cost_per_token: 6e-6,
								range: [128000, 256000],
								cache_read_input_token_cost: 3e-7,
							},
						],
					},
				}),
			});

			// Test with 150,000 tokens (should use tier 3)
			const cost = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 150000,
				output_tokens: 20000,
				cache_read_input_tokens: 10000,
			}, 'kat-coder-pro-v1'));

			const expectedCost = 0.34800000000000003;
			expect(cost).toBeCloseTo(expectedCost);
		});

		it('correctly handles boundary cases for input length-based tiered pricing', async () => {
			using fetcher = new PricingFetcher({
				offlineLoader: async () => ({
					'kat-coder-pro-v1': {
						input_cost_per_token: 6e-7,
						output_cost_per_token: 2.4e-6,
						cache_read_input_token_cost: 1.2e-7,
						tiered_pricing: [
							{
								input_cost_per_token: 6e-7,
								output_cost_per_token: 2.4e-6,
								range: [0, 32000],
								cache_read_input_token_cost: 1.2e-7,
							},
							{
								input_cost_per_token: 9e-7,
								output_cost_per_token: 3.6e-6,
								range: [32000, 128000],
								cache_read_input_token_cost: 1.8e-7,
							},
							{
								input_cost_per_token: 1.5e-6,
								output_cost_per_token: 6e-6,
								range: [128000, 256000],
								cache_read_input_token_cost: 3e-7,
							},
						],
					},
				}),
			});

			// Test boundary at 32,000 (should use tier 1)
			const cost32k = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 32000,
				output_tokens: 0,
			}, 'kat-coder-pro-v1'));
			expect(cost32k).toBeCloseTo(0.0192);

			// Test boundary at 32,001 (should use tier 2)
			const cost32k1 = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 32001,
				output_tokens: 0,
			}, 'kat-coder-pro-v1'));
			expect(cost32k1).toBeCloseTo(0.0288009);

			// Test boundary at 128,000 (should use tier 2)
			const cost128k = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 128000,
				output_tokens: 0,
			}, 'kat-coder-pro-v1'));
			expect(cost128k).toBeCloseTo(0.1152);

			// Test boundary at 128,001 (should use tier 3)
			const cost128k1 = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 128001,
				output_tokens: 0,
			}, 'kat-coder-pro-v1'));
			expect(cost128k1).toBeCloseTo(0.1920015);
		});

		it('handles free models with input length-based tiered pricing (KAT-Coder-Air V1)', async () => {
			using fetcher = new PricingFetcher({
				offlineLoader: async () => ({
					'kat-coder-air-v1': {
						input_cost_per_token: 0,
						output_cost_per_token: 0,
						tiered_pricing: [
							{
								input_cost_per_token: 0,
								output_cost_per_token: 0,
								range: [0, 128000],
								cache_read_input_token_cost: 0,
							},
						],
					},
				}),
			});

			// Test with 50,000 tokens (should be free)
			const cost = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 50000,
				output_tokens: 10000,
				cache_read_input_tokens: 5000,
			}, 'kat-coder-air-v1'));

			expect(cost).toBe(0);
		});

		it('falls back to base pricing when tiered_pricing is not defined', async () => {
			using fetcher = new PricingFetcher({
				offlineLoader: async () => ({
					'regular-model': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 2e-6,
						cache_read_input_token_cost: 1e-7,
						// No tiered_pricing array
					},
				}),
			});

			const cost = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 50000,
				output_tokens: 10000,
				cache_read_input_tokens: 5000,
			}, 'regular-model'));

			const expectedCost = (50000 * 1e-6) + (10000 * 2e-6) + (5000 * 1e-7);
			expect(cost).toBeCloseTo(expectedCost);
		});
	});
}
