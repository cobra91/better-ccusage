#!/usr/bin/env node
/**
 * sync-pricing.ts — Sync static pricing JSON with LiteLLM remote data.
 *
 * Fetches the LiteLLM model pricing database, filters to relevant providers,
 * and merges new models into the local static JSON file.
 *
 * Usage:
 *   pnpm tsx scripts/sync-pricing.ts [--force] [--dry-run]
 *
 * Options:
 *   --force     Skip the OFFLINE environment variable check
 *   --dry-run   Preview changes without writing
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';

// @ts-expect-error — TSX resolves this from source
import { fetchLiteLLMPricingDataset } from '../packages/internal/src/pricing-fetch-utils.ts';
// @ts-expect-error — TSX resolves this from source
import { isRelevantProvider } from '../packages/internal/src/remote-pricing.ts';
// @ts-expect-error — TSX resolves this from source
import type { LiteLLMModelPricing } from '../packages/internal/src/pricing.ts';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isForce = args.includes('--force');

const monorepoRoot = resolve(fileURLToPath(import.meta.url), '..');
const staticJsonPath = resolve(monorepoRoot, 'packages', 'internal', 'model_prices_and_context_window.json');

async function main(): Promise<void> {
	if (!isForce && env.OFFLINE === 'true') {
		console.log('[sync-pricing] OFFLINE is set. Use --force to override.');
		process.exit(1);
	}

	console.log('[sync-pricing] Fetching LiteLLM pricing database...');

	const litellmDataset = await fetchLiteLLMPricingDataset();
	console.log(`[sync-pricing] Fetched ${Object.keys(litellmDataset).length} models from LiteLLM.`);

	// Load existing static JSON
	const staticRaw = readFileSync(staticJsonPath, 'utf8');
	const staticData = JSON.parse(staticRaw) as Record<string, unknown>;

	// Filter LiteLLM to relevant providers
	const relevantModels: Record<string, unknown> = {};
	for (const [name, pricing] of Object.entries(litellmDataset)) {
		if (isRelevantProvider(name, pricing as LiteLLMModelPricing)) {
			relevantModels[name] = pricing;
		}
	}
	console.log(`[sync-pricing] ${Object.keys(relevantModels).length} models after provider filter.`);

	// Merge: update existing entries, add new ones
	let updated = 0;
	let added = 0;

	for (const [name, pricing] of Object.entries(relevantModels)) {
		if (name in staticData) {
			// Update pricing fields only, preserve extra fields (mode, supports_*, etc.)
			const existing = staticData[name] as Record<string, unknown>;
			const incoming = pricing as Record<string, unknown>;
			const merged = { ...existing };

			// Update pricing-related fields
			for (const key of Object.keys(incoming)) {
				if (typeof incoming[key] === 'number' || typeof incoming[key] === 'boolean') {
					merged[key] = incoming[key];
				}
			}

			staticData[name] = merged;
			updated++;
		}
		else {
			// New model — add full entry
			staticData[name] = pricing;
			added++;
		}
	}

	console.log(`[sync-pricing] ${updated} existing models updated, ${added} new models added.`);
	console.log(`[sync-pricing] Total models in static JSON: ${Object.keys(staticData).length}`);

	if (isDryRun) {
		console.log('[sync-pricing] Dry run — no changes written.');
		return;
	}

	writeFileSync(staticJsonPath, JSON.stringify(staticData, null, '\t') + '\n');
	console.log(`[sync-pricing] Written to ${staticJsonPath}`);
}

main().catch((error) => {
	console.error('[sync-pricing] Error:', error);
	process.exit(1);
});
