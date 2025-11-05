import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'src/pricing.ts',
		'src/pricing-fetch-utils.ts',
		'src/logger.ts',
		'src/format.ts',
		'src/constants.ts',
	],
	format: ['esm'],
	target: 'node20',
	clean: true,
	dts: true,
});