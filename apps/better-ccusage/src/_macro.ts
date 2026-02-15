import type { ModelPricing } from '@better-ccusage/internal/pricing';
import {
	createPricingDataset,
	loadLocalPricingDataset,
} from '@better-ccusage/internal/pricing-fetch-utils';

/**
 * Load all pricing data from the local dataset.
 * No filtering needed - the pricing fetcher's fallback logic handles all models automatically.
 */
export async function prefetchAllPricing(): Promise<Record<string, ModelPricing>> {
	try {
		// Always use local pricing data
		return loadLocalPricingDataset();
	}
	catch (error) {
		console.warn('Failed to load local pricing data, proceeding with empty cache.', error);
		return createPricingDataset();
	}
}
