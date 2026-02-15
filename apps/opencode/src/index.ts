#!/usr/bin/env node
import { run } from './commands/index.ts';

run().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});
