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
});
