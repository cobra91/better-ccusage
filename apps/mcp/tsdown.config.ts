import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts'],
	outDir: 'dist',
	format: 'esm',
	clean: true,
	sourcemap: false,
	minify: 'dce-only',
	treeshake: true,
	fixedExtension: false,
	dts: {
		tsgo: true,
	},
	publint: true,
	unused: true,
	exports: {
		devExports: true,
	},
	nodeProtocol: true,
	define: {
		'import.meta.vitest': 'undefined',
	},
	onSuccess: [
		'sort-package-json',
		'node -e "require(\'fs\').copyFileSync(\'../../packages/internal/model_prices_and_context_window.json\',\'dist/model_prices_and_context_window.json\')"',
	],
});
