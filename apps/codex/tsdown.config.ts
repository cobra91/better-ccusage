import { defineConfig } from 'tsdown';
import Macros from 'unplugin-macros/rolldown';

export default defineConfig({
	entry: ['src/index.ts'],
	outDir: 'dist',
	format: 'esm',
	clean: true,
	sourcemap: false,
	minify: 'dce-only',
	treeshake: true,
	dts: false,
	publint: true,
	unused: true,
	nodeProtocol: true,
	fixedExtension: false,
	plugins: [
		Macros({
			include: ['src/index.ts', 'src/pricing.ts'],
		}),
	],
	define: {
		'import.meta.vitest': 'undefined',
	},
	onSuccess: [
		'sort-package-json',
		'node -e "require(\'fs\').copyFileSync(\'../../packages/internal/model_prices_and_context_window.json\',\'dist/model_prices_and_context_window.json\')"',
	],
});
