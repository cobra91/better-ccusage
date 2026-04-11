import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface RolldownPlugin {
	name: string;
	writeBundle(): void;
}

const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(monorepoRoot, 'packages', 'internal', 'model_prices_and_context_window.json');

/**
 * Rolldown plugin that copies model_prices_and_context_window.json into the
 * app's dist/ directory after the bundle is written. Runs in-process so it
 * works reliably on Windows where tsdown's onSuccess shell quoting breaks.
 */
export function copyPricingPlugin(appName: string): RolldownPlugin {
	return {
		name: 'copy-pricing-json',
		writeBundle() {
			if (!existsSync(src)) {
				throw new Error(`[copy-pricing-json] Source not found: ${src}`);
			}

			const dest = resolve(monorepoRoot, 'apps', appName, 'dist', 'model_prices_and_context_window.json');
			mkdirSync(dirname(dest), { recursive: true });
			copyFileSync(src, dest);
			console.log(`[copy-pricing-json] Copied pricing JSON to ${dest}`);
		},
	};
}
