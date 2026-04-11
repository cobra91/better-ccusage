import { defineConfig } from 'tsdown';
import { copyPricingPlugin } from '../../scripts/copy-pricing-plugin.ts';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/data-loader.ts',
		'src/cost-utils.ts',
	],
	format: 'esm',
	dts: true,
	clean: true,
	minify: false,
	sourcemap: true,
	external: [],
	plugins: [copyPricingPlugin('opencode')],
});
