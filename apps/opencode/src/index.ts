#!/usr/bin/env node
import process from 'node:process';
import { run } from './run.ts';

// eslint-disable-next-line antfu/no-top-level-await
await run();
