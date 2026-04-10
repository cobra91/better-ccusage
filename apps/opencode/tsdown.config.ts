import { defineConfig } from 'tsdown';

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
	onSuccess: [
		'node -e "require(\'fs\').copyFileSync(\'../../packages/internal/model_prices_and_context_window.json\',\'dist/model_prices_and_context_window.json\')"',
	],
});
