import { defineConfig } from 'tsdown';
import Macros from 'unplugin-macros/rolldown';
import { copyPricingPlugin } from '../../scripts/copy-pricing-plugin.ts';

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
		copyPricingPlugin('codex'),
	],
	define: {
		'import.meta.vitest': 'undefined',
	},
});
