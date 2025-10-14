import type { Args } from 'gunshi';
import { DEFAULT_LOCALE, DEFAULT_TIMEZONE } from './_consts.ts';

export const sharedArgs = {
	json: {
		type: 'boolean',
		short: 'j',
		description: 'Output report as JSON',
		default: false,
	},
	since: {
		type: 'string',
		short: 's',
		description: 'Filter from date (YYYY-MM-DD or YYYYMMDD)',
	},
	until: {
		type: 'string',
		short: 'u',
		description: 'Filter until date (inclusive)',
	},
	timezone: {
		type: 'string',
		short: 'z',
		description: 'Timezone for date grouping (IANA)',
		default: DEFAULT_TIMEZONE,
	},
	locale: {
		type: 'string',
		short: 'l',
		description: 'Locale for formatting',
		default: DEFAULT_LOCALE,
	},
	compact: {
		type: 'boolean',
		description: 'Force compact table layout for narrow terminals',
		default: false,
	},
	color: { // --color / --no-color; env NO_COLOR / FORCE_COLOR handled by picocolors
		type: 'boolean',
		description: 'Enable or disable colored output (default: auto via NO_COLOR/FORCE_COLOR).',
		negatable: true,
	},
} as const satisfies Args;
