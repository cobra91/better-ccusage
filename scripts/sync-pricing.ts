#!/usr/bin/env node
/**
 * sync-pricing.ts — Sync static pricing JSON with LiteLLM remote data.
 *
 * Fetches the LiteLLM model pricing database, filters to relevant providers,
 * and merges new models into the local static JSON file.
 *
 * Usage:
 *   bun scripts/sync-pricing.ts [--force] [--dry-run] [--check]
 *
 * Options:
 *   --force     Skip the OFFLINE environment variable check
 *   --dry-run   Preview changes without writing
 *   --check     Verify only, never writes. Exits 1 when a price already in the
 *               bundle differs from LiteLLM or when a bundle copy differs from
 *               the canonical file (the release workflow refuses to publish in
 *               that case), 2 when there is no usable LiteLLM data, so an
 *               unreachable or emptied source never blocks a release.
 *
 * Only a differing price counts as stale under --check. Models missing from
 * the bundle and metadata-only differences are reported but do not fail: the
 * runtime fetch supplies a missing model within 24h, whereas a bundled price
 * always overrides LiteLLM.
 *
 * Exit codes: 0 ok, 1 stale price, drifted bundle copy or OFFLINE without
 * --force, 2 check skipped (no usable LiteLLM data), 3 error.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { fetchLiteLLMPricingDataset } from '../packages/internal/src/pricing-fetch-utils.ts';
import type { LiteLLMModelPricing } from '../packages/internal/src/pricing.ts';
import { isRelevantProvider } from '../packages/internal/src/remote-pricing.ts';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isForce = args.includes('--force');
const isCheck = args.includes('--check');

const monorepoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const staticJsonPath = resolve(monorepoRoot, 'packages', 'internal', 'model_prices_and_context_window.json');

/**
 * Tracked copies kept identical to the canonical file. They are only read as
 * fallbacks, so a copy left behind by a sync would shadow the canonical file.
 * All of them must exist: a missing copy fails the check, which would
 * otherwise skip it silently.
 */
const siblingJsonPaths = [
	resolve(monorepoRoot, 'model_prices_and_context_window.json'),
	resolve(monorepoRoot, 'apps', 'better-ccusage', 'model_prices_and_context_window.json'),
];

/**
 * Floors below which the comparison proves nothing. LiteLLM serves about 7000
 * models, about 450 pass the provider filter, and about 400 of those share a
 * price with the bundle. An empty or truncated dataset fails the first two. A
 * renamed price field leaves those counts intact but compares no price, which
 * is what the third floor catches.
 */
const MIN_FETCHED_MODELS = 1000;
const MIN_RELEVANT_MODELS = 100;
const MIN_COMPARED_PRICES = 100;

/** Price fields of one pricing tier, as the bundled pricing schema defines them. */
const TIER_PRICE_FIELDS = ['input_cost_per_token', 'output_cost_per_token', 'range', 'cache_read_input_token_cost'];

type StaticBundle = Record<string, Record<string, unknown>>;

type PriceChange = {
	name: string;
	field: string;
	before: unknown;
	after: unknown;
};

type SyncChanges = {
	added: string[];
	priceChanges: PriceChange[];
	metadataOnly: string[];
	/** LiteLLM models left out because the cost engine cannot price them. */
	skippedUnpriceable: number;
	/** Bundled entries whose price was actually compared with LiteLLM. */
	comparedPrices: number;
	/** Models priced by tiers in the bundle that LiteLLM carries no tiers for. */
	tiersOnlyInBundle: string[];
};

function isTierList(value: unknown): value is Record<string, unknown>[] {
	return Array.isArray(value);
}

/**
 * The prices inside a tier list, ignoring field order and fields the engine
 * does not read, so that a mere difference of shape is not a price change.
 */
function tierPrices(tiers: Record<string, unknown>[]): string {
	return JSON.stringify(tiers.map(tier => TIER_PRICE_FIELDS.map(field => tier[field] ?? null)));
}

function isPriceField(key: string): boolean {
	return key.toLowerCase().includes('cost');
}

/**
 * Whether the token-based cost engine can price the entry at all: flat
 * per-token fields or tiered pricing. Alias stubs and models billed per
 * image, second or request have neither.
 */
function isPriceable(entry: Record<string, unknown>): boolean {
	if (typeof entry['input_cost_per_token'] === 'number' || typeof entry['output_cost_per_token'] === 'number') {
		return true;
	}
	return Array.isArray(entry['tiered_pricing']) && entry['tiered_pricing'].length > 0;
}

function formatValue(value: unknown): string {
	if (typeof value === 'number') {
		return String(value);
	}
	return isTierList(value) ? JSON.stringify(value) : 'none';
}

/**
 * Merge the relevant LiteLLM models into the static bundle and describe what
 * changed. The bundle is modified in place.
 */
function mergeInto(staticData: StaticBundle, relevant: Record<string, LiteLLMModelPricing>): SyncChanges {
	const changes: SyncChanges = { added: [], priceChanges: [], metadataOnly: [], skippedUnpriceable: 0, comparedPrices: 0, tiersOnlyInBundle: [] };

	for (const [name, pricing] of Object.entries(relevant)) {
		const incoming = pricing as unknown as Record<string, unknown>;
		const existing = staticData[name];

		if (existing == null) {
			if (isPriceable(incoming)) {
				// New model — add full entry
				staticData[name] = incoming;
				changes.added.push(name);
			}
			else {
				// A bundled entry with no usable price would be found first and cost
				// $0 silently, where a missing model at least warns.
				changes.skippedUnpriceable += 1;
			}
			continue;
		}

		// Update pricing fields only, preserve extra fields (mode, supports_*, etc.)
		const merged: Record<string, unknown> = { ...existing };
		for (const [key, value] of Object.entries(incoming)) {
			if (typeof value === 'number' || typeof value === 'boolean') {
				merged[key] = value;
			}
		}

		const modelPriceChanges: PriceChange[] = [];
		let hasMetadataChange = false;
		for (const key of Object.keys(merged)) {
			if (JSON.stringify(merged[key]) === JSON.stringify(existing[key])) {
				continue;
			}
			if (isPriceField(key)) {
				modelPriceChanges.push({ name, field: key, before: existing[key], after: merged[key] });
			}
			else {
				hasMetadataChange = true;
			}
		}

		// Tiers are a list, so the scalar copy above never reaches them. LiteLLM
		// is followed only where it carries tiers for the model; tiers that exist
		// only in the bundle are neither updated nor verified.
		if (isTierList(incoming['tiered_pricing'])) {
			const incomingTiers = tierPrices(incoming['tiered_pricing']);
			if (!isTierList(existing['tiered_pricing']) || incomingTiers !== tierPrices(existing['tiered_pricing'])) {
				merged['tiered_pricing'] = incoming['tiered_pricing'];
				modelPriceChanges.push({ name, field: 'tiered_pricing', before: existing['tiered_pricing'], after: incoming['tiered_pricing'] });
			}
		}
		else if (isTierList(existing['tiered_pricing'])) {
			changes.tiersOnlyInBundle.push(name);
		}
		if (isPriceable(incoming)) {
			changes.comparedPrices += 1;
		}

		staticData[name] = merged;
		if (modelPriceChanges.length > 0) {
			changes.priceChanges.push(...modelPriceChanges);
		}
		else if (hasMetadataChange) {
			changes.metadataOnly.push(name);
		}
	}

	return changes;
}

function printReport(changes: SyncChanges): void {
	console.log(`[sync-pricing] ${changes.added.length} new models added, ${changes.skippedUnpriceable} left out (no usable price).`);
	console.log(`[sync-pricing] ${changes.priceChanges.length} bundled prices out of date, ${changes.metadataOnly.length} models with metadata-only differences.`);
	console.log(`[sync-pricing] Compared ${changes.comparedPrices} bundled prices with LiteLLM.`);
	if (changes.tiersOnlyInBundle.length > 0) {
		console.log(`[sync-pricing] ${changes.tiersOnlyInBundle.length} bundled tiered prices exist only in the bundle and were not checked: ${changes.tiersOnlyInBundle.join(', ')}`);
	}

	const byModel = new Map<string, PriceChange[]>();
	for (const change of changes.priceChanges) {
		const modelChanges = byModel.get(change.name) ?? [];
		modelChanges.push(change);
		byModel.set(change.name, modelChanges);
	}
	for (const [name, modelChanges] of byModel) {
		const detail = modelChanges
			.map(change => `${change.field} ${formatValue(change.before)} -> ${formatValue(change.after)}`)
			.join('; ');
		console.log(`[sync-pricing]   ${name}: ${detail}`);
	}
}

async function main(): Promise<void> {
	if (!isForce && env.OFFLINE === 'true') {
		if (isCheck) {
			console.error('[sync-pricing] OFFLINE is set, bundled prices were not verified.');
			exit(2);
		}
		console.log('[sync-pricing] OFFLINE is set. Use --force to override.');
		exit(1);
	}

	console.log('[sync-pricing] Fetching LiteLLM pricing database...');
	let litellmDataset: Record<string, LiteLLMModelPricing>;
	try {
		litellmDataset = await fetchLiteLLMPricingDataset();
	}
	catch (error) {
		if (!isCheck) {
			throw error;
		}
		console.error(`[sync-pricing] LiteLLM could not be fetched, bundled prices were not verified: ${String(error)}`);
		exit(2);
	}
	const fetchedCount = Object.keys(litellmDataset).length;
	console.log(`[sync-pricing] Fetched ${fetchedCount} models from LiteLLM.`);

	// Load existing static JSON
	const staticRaw = readFileSync(staticJsonPath, 'utf8');
	const staticData = JSON.parse(staticRaw) as StaticBundle;
	const missingCopies = [staticJsonPath, ...siblingJsonPaths].filter(path => !existsSync(path));
	if (missingCopies.length > 0) {
		const detail = `Bundle ${missingCopies.length === 1 ? 'copy is' : 'copies are'} missing: ${missingCopies.join(', ')}`;
		if (!isCheck) {
			throw new Error(detail);
		}
		console.error(`[sync-pricing] ${detail}. Restore ${missingCopies.length === 1 ? 'it' : 'them'} from the canonical file and commit.`);
		exit(1);
	}

	// Filter LiteLLM to relevant providers
	const relevantModels: Record<string, LiteLLMModelPricing> = {};
	for (const [name, pricing] of Object.entries(litellmDataset)) {
		if (isRelevantProvider(name, pricing)) {
			relevantModels[name] = pricing;
		}
	}
	const relevantCount = Object.keys(relevantModels).length;
	console.log(`[sync-pricing] ${relevantCount} models after provider filter.`);

	const changes = mergeInto(staticData, relevantModels);

	const tooSmall = fetchedCount < MIN_FETCHED_MODELS || relevantCount < MIN_RELEVANT_MODELS;
	if (tooSmall || changes.comparedPrices < MIN_COMPARED_PRICES) {
		const detail = `LiteLLM returned ${fetchedCount} models, ${relevantCount} after the provider filter and ${changes.comparedPrices} prices comparable with the bundle (expected at least ${MIN_FETCHED_MODELS}, ${MIN_RELEVANT_MODELS} and ${MIN_COMPARED_PRICES})`;
		if (isCheck) {
			console.error(`[sync-pricing] ${detail}: the dataset looks empty or its schema changed, bundled prices were not verified.`);
			exit(2);
		}
		throw new Error(detail);
	}

	printReport(changes);
	console.log(`[sync-pricing] Total models in static JSON: ${Object.keys(staticData).length}.`);

	if (isCheck) {
		const problems: string[] = [];
		if (changes.priceChanges.length > 0) {
			problems.push('Bundled prices are behind LiteLLM. Run scripts/sync-pricing.ts, merge the result, then tag the release again.');
		}
		const driftedCopies = siblingJsonPaths.filter(path => readFileSync(path, 'utf8') !== staticRaw);
		if (driftedCopies.length > 0) {
			problems.push(`Bundle ${driftedCopies.length === 1 ? 'copy differs' : 'copies differ'} from the canonical file: ${driftedCopies.join(', ')}. Copy the canonical file over ${driftedCopies.length === 1 ? 'it' : 'them'} and commit.`);
		}
		if (problems.length > 0) {
			for (const problem of problems) {
				console.error(`[sync-pricing] ${problem}`);
			}
			exit(1);
		}
		console.log('[sync-pricing] Bundled prices are up to date with LiteLLM.');
		return;
	}

	if (isDryRun) {
		console.log('[sync-pricing] Dry run — no changes written.');
		return;
	}

	const serialized = JSON.stringify(staticData, null, '\t') + '\n';
	for (const path of siblingJsonPaths) {
		if (readFileSync(path, 'utf8') !== staticRaw) {
			console.log(`[sync-pricing] Note: ${path} differed from the canonical file before this sync.`);
		}
	}
	for (const path of [staticJsonPath, ...siblingJsonPaths]) {
		writeFileSync(path, serialized);
	}
	console.log(`[sync-pricing] Written to ${[staticJsonPath, ...siblingJsonPaths].join(', ')}`);
}

main().catch((error) => {
	console.error('[sync-pricing] Error:', error);
	process.exit(3);
});
