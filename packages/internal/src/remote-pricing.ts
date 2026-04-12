/// <reference types="vitest" />

import type { LiteLLMModelPricing, ModelPricing } from './pricing.ts';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import * as v from 'valibot';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
	loadLocalPricingDataset,
} from './pricing-fetch-utils.ts';
import { modelPricingSchema } from './pricing.ts';

/**
 * Cache TTL in milliseconds (24 hours).
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Provider patterns to keep from LiteLLM.
 * Models matching any of these prefixes or patterns are retained.
 * Everything else (Bedrock, Fireworks, Azure, Vertex, GMI, deepinfra, Novita, Cerebras, etc.) is stripped.
 */
const RELEVANT_PROVIDER_PATTERNS = [
	'anthropic/',
	'anthropic.',
	'claude-',
	'openai/',
	'gpt-',
	'chatgpt-',
	'o1-',
	'o3-',
	'o4-',
	'zai/',
	'z-ai/',
	'glm-',
	'minimax/',
	'minimax.',
	'MiniMax-',
	'MiniMaxAI/',
	'moonshot/',
	'kimi-',
	'kat-coder',
	'kat-dev',
	'dashscope/',
	'qwen-',
	'google/',
	'gemini-',
];

/**
 * Providers to strip from model keys (Bedrock, Fireworks, Azure, Vertex, etc.)
 */
const STRIP_PROVIDER_PREFIXES = [
	'bedrock/',
	'fireworks_ai/',
	'baseten/',
	'deepinfra/',
	'novita/',
	'cerebras/',
	'together_ai/',
	'vercel_ai_gateway/',
	'wandb/',
	'gmi/',
	'openrouter/',
];

/**
 * Check if a model is from a relevant provider.
 * Matches against model name (key) and provider field from LiteLLM data.
 */
export function isRelevantProvider(modelName: string, pricing: LiteLLMModelPricing): boolean {
	const provider = pricing.provider ?? '';

	// Skip irrelevant deployment platforms
	for (const prefix of STRIP_PROVIDER_PREFIXES) {
		if (modelName.startsWith(prefix)) {
			return false;
		}
	}

	// Match against relevant patterns
	for (const pattern of RELEVANT_PROVIDER_PATTERNS) {
		if (modelName.startsWith(pattern)) {
			return true;
		}
	}

	// Also match by provider field for bare model names (e.g. "MiniMax-M2.7")
	const relevantProviders = ['anthropic', 'openai', 'minimax', 'moonshot', 'dashscope', 'google'];
	if (relevantProviders.includes(provider)) {
		return true;
	}

	return false;
}

/**
 * Fetch LiteLLM pricing data filtered to relevant providers only.
 */
async function fetchFilteredRemotePricing(): Promise<Record<string, ModelPricing>> {
	const litellmDataset = await fetchLiteLLMPricingDataset();
	const filtered = filterPricingDataset(
		litellmDataset as unknown as Record<string, ModelPricing>,
		(modelName, pricing) => isRelevantProvider(modelName, pricing as unknown as LiteLLMModelPricing),
	);

	// Re-validate through our stricter schema to get clean ModelPricing
	const dataset = createPricingDataset();
	for (const [name, pricing] of Object.entries(filtered)) {
		const parsed = v.safeParse(modelPricingSchema, pricing);
		if (parsed.success && parsed.output.input_cost_per_token != null) {
			dataset[name] = parsed.output;
		}
	}

	return dataset;
}

/**
 * Get the cache directory path.
 * Uses XDG_CACHE_HOME on Linux/macOS, LOCALAPPDATA on Windows.
 */
function getCacheDir(): string {
	const xdgCache = process.env.XDG_CACHE_HOME;
	if (xdgCache) {
		return join(xdgCache, 'better-ccusage');
	}

	if (process.platform === 'win32') {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData) {
			return join(localAppData, 'better-ccusage', 'cache');
		}
	}

	return join(process.env.HOME ?? process.env.USERPROFILE ?? '/', '.cache', 'better-ccusage');
}

function getCachePath(): string {
	return join(getCacheDir(), 'pricing.json');
}

type PricingCache = {
	timestamp: number;
	dataset: Record<string, ModelPricing>;
};

/**
 * Read the cache file. Returns null if missing, expired, or corrupt.
 */
function readCacheFile(): PricingCache | null {
	const cachePath = getCachePath();
	if (!existsSync(cachePath)) {
		return null;
	}

	try {
		const raw = readFileSync(cachePath, 'utf8');
		const cache = JSON.parse(raw) as PricingCache;

		if (typeof cache.timestamp !== 'number' || typeof cache.dataset !== 'object') {
			return null;
		}

		if (Date.now() - cache.timestamp > CACHE_TTL_MS) {
			return null;
		}

		return cache;
	}
	catch {
		return null;
	}
}

/**
 * Write the merged dataset to cache.
 */
function writeCacheFile(dataset: Record<string, ModelPricing>): void {
	const cachePath = getCachePath();
	const cacheDir = dirname(cachePath);

	mkdirSync(cacheDir, { recursive: true });

	const cache: PricingCache = {
		timestamp: Date.now(),
		dataset,
	};

	writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
}

/**
 * Merge remote pricing data into static pricing data.
 * Static entries are NEVER overwritten — they take priority.
 * This protects tiered pricing data that only exists in the static JSON.
 */
function mergePricingDatasets(
	staticData: Record<string, ModelPricing>,
	remoteData: Record<string, ModelPricing>,
): Record<string, ModelPricing> {
	const merged = { ...remoteData };

	for (const [name, pricing] of Object.entries(staticData)) {
		if (pricing.input_cost_per_token != null) {
			merged[name] = pricing;
		}
	}

	return merged;
}

/**
 * Load merged pricing data: cache → remote → static fallback.
 *
 * Strategy:
 * 1. Load static dataset (always available, fast)
 * 2. Check cache file — if fresh (< 24h), merge cache with static
 * 3. If cache stale/missing and not OFFLINE, fetch LiteLLM, filter, merge
 * 4. Write merged result to cache
 * 5. Return merged dataset
 *
 * If everything fails (offline + no cache), returns static-only dataset.
 */
export async function loadMergedPricing(): Promise<Record<string, ModelPricing>> {
	// Step 1: Always load static as base
	const staticData = loadLocalPricingDataset();

	// Step 2: Check cache
	const cache = readCacheFile();
	if (cache != null) {
		const merged = mergePricingDatasets(staticData, cache.dataset);
		return merged;
	}

	// Step 3: Skip remote fetch if OFFLINE
	if (process.env.OFFLINE === 'true') {
		return staticData;
	}

	// Step 4: Fetch remote
	try {
		const remoteData = await fetchFilteredRemotePricing();
		const merged = mergePricingDatasets(staticData, remoteData);

		// Step 5: Write to cache
		writeCacheFile(merged);

		return merged;
	}
	catch {
		// Fallback: return static only
		return staticData;
	}
}

if (import.meta.vitest != null) {
	describe('isRelevantProvider', () => {
		it('keeps Claude models', () => {
			expect(isRelevantProvider('claude-sonnet-4-20250514', { provider: 'anthropic' })).toBe(true);
			expect(isRelevantProvider('anthropic/claude-sonnet-4-20250514', { provider: 'anthropic' })).toBe(true);
		});

		it('keeps GLM models', () => {
			expect(isRelevantProvider('glm-4.5', { provider: undefined })).toBe(true);
			expect(isRelevantProvider('zai/glm-4.5', { provider: undefined })).toBe(true);
		});

		it('keeps MiniMax models', () => {
			expect(isRelevantProvider('MiniMax-M2.7', { provider: 'minimax' })).toBe(true);
			expect(isRelevantProvider('minimax/minimax-m2.7', { provider: undefined })).toBe(true);
		});

		it('keeps Moonshot/Kimi models', () => {
			expect(isRelevantProvider('moonshot/kimi-for-coding', { provider: undefined })).toBe(true);
			expect(isRelevantProvider('kimi-for-coding', { provider: undefined })).toBe(true);
		});

		it('keeps OpenAI models', () => {
			expect(isRelevantProvider('gpt-5', { provider: 'openai' })).toBe(true);
			expect(isRelevantProvider('o3-mini', { provider: undefined })).toBe(true);
		});

		it('keeps KAT-Coder models', () => {
			expect(isRelevantProvider('kat-coder-pro-v1', { provider: undefined })).toBe(true);
		});

		it('keeps Gemini models', () => {
			expect(isRelevantProvider('gemini-2.5-pro', { provider: 'google' })).toBe(true);
			expect(isRelevantProvider('google/gemini-2.5-pro', { provider: undefined })).toBe(true);
		});

		it('strips Bedrock variants', () => {
			expect(isRelevantProvider('bedrock/us-east-1/anthropic.claude-sonnet-4', { provider: 'anthropic' })).toBe(false);
		});

		it('strips Fireworks variants', () => {
			expect(isRelevantProvider('fireworks_ai/accounts/fireworks/models/minimax-m2', { provider: undefined })).toBe(false);
		});

		it('strips Azure/Vertex/GMI/deepinfra/Novita variants', () => {
			expect(isRelevantProvider('azure/openai/gpt-5', { provider: undefined })).toBe(false);
			expect(isRelevantProvider('vertex_ai/zai-org/glm-4.5', { provider: undefined })).toBe(false);
			expect(isRelevantProvider('deepinfra/zai-org/GLM-4.5', { provider: undefined })).toBe(false);
			expect(isRelevantProvider('novita/zai-org/glm-4.7', { provider: undefined })).toBe(false);
			expect(isRelevantProvider('gmi/zai-org/GLM-4.7-FP8', { provider: undefined })).toBe(false);
		});

		it('strips openrouter proxy variants', () => {
			expect(isRelevantProvider('openrouter/anthropic/claude-sonnet-4', { provider: undefined })).toBe(false);
		});
	});

	describe('mergePricingDatasets', () => {
		it('adds new models from remote', () => {
			const staticData = createPricingDataset();
			staticData['claude-sonnet-4'] = { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6 };

			const remoteData = createPricingDataset();
			remoteData['MiniMax-M2.7'] = { input_cost_per_token: 3e-7, output_cost_per_token: 1.2e-6 };

			const merged = mergePricingDatasets(staticData, remoteData);
			expect(merged['claude-sonnet-4']).toBeDefined();
			expect(merged['MiniMax-M2.7']).toBeDefined();
		});

		it('never overwrites static entries', () => {
			const staticData = createPricingDataset();
			staticData['claude-sonnet-4'] = { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6, cache_read_input_token_cost: 3e-7 };

			const remoteData = createPricingDataset();
			remoteData['claude-sonnet-4'] = { input_cost_per_token: 5e-6, output_cost_per_token: 20e-6 };

			const merged = mergePricingDatasets(staticData, remoteData);
			expect(merged['claude-sonnet-4']?.input_cost_per_token).toBe(3e-6);
			expect(merged['claude-sonnet-4']?.cache_read_input_token_cost).toBe(3e-7);
		});

		it('handles empty remote dataset', () => {
			const staticData = createPricingDataset();
			staticData['glm-4.5'] = { input_cost_per_token: 6e-7, output_cost_per_token: 2.2e-6 };

			const merged = mergePricingDatasets(staticData, {});
			expect(Object.keys(merged)).toEqual(['glm-4.5']);
		});

		it('handles empty static dataset', () => {
			const remoteData = createPricingDataset();
			remoteData['MiniMax-M2.7'] = { input_cost_per_token: 3e-7, output_cost_per_token: 1.2e-6 };

			const merged = mergePricingDatasets({}, remoteData);
			expect(merged['MiniMax-M2.7']).toBeDefined();
		});
	});
}
