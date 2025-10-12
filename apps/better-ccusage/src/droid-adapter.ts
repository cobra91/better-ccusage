/**
 * @fileoverview Droid data adapter for processing droid session data
 *
 * This module provides functions for parsing and transforming droid session data
 * to match the better-ccusage expected format. It handles provider-to-model mapping
 * and token field transformations.
 *
 * @module droid-adapter
 */

import type {
	ModelName,
} from './_types.ts';
import type { LoadOptions } from './data-loader.ts';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Result } from '@praha/byethrow';
import { isDirectorySync, isFileSync } from 'path-type';
import { globSync } from 'tinyglobby';
import * as v from 'valibot';
import { DEFAULT_DROID_SESSIONS_PATH, USER_HOME_DIR } from './_consts.ts';
import { createModelName, createSessionId } from './_types.ts';
import { logger } from './logger.ts';

/**
 * Droid session file structure from .settings.json
 */
const droidSettingsSchema = v.object({
	assistantActiveTimeMs: v.optional(v.number()),
	providerLock: v.optional(v.string()),
	providerLockTimestamp: v.optional(v.string()),
	apiProviderLock: v.optional(v.string()),
	tokenUsage: v.optional(v.object({
		inputTokens: v.number(),
		outputTokens: v.number(),
		cacheCreationTokens: v.number(),
		cacheReadTokens: v.number(),
		thinkingTokens: v.number(),
	})),
});

/**
 * Droid session file structure from JSONL (first line usually)
 */
const droidSessionStartSchema = v.object({
	type: v.string(),
	id: v.string(),
	title: v.optional(v.string()),
	owner: v.optional(v.string()),
});

/**
 * Provider-to-model mapping based on droid configuration
 */
function mapProviderToModel(provider: string | undefined, apiProvider: string | undefined): ModelName {
	// Handle custom API providers first
	if (apiProvider === 'baseten' && provider === 'openai') {
		return createModelName('gpt-5');
	}

	// Handle generic chat completion API (Z.ai)
	if (apiProvider === 'generic-chat-completion-api' || provider === 'generic-chat-completion-api') {
		return createModelName('glm-4.6');
	}

	// Handle direct provider mapping
	switch (provider) {
		case 'anthropic':
			return createModelName('sonnet-4-5');
		case 'openai':
			return createModelName('gpt-5');
		case undefined:
			return createModelName(provider ?? 'unknown');
		default:
			// Fallback to a generic model name
			return createModelName(provider);
	}
}

/**
 * Parse droid session files and transform to better-ccusage format
 * @param sessionPath - Path to droid session directory
 * @param sessionId - Session ID (directory name)
 * @param options - Load options for processing
 * @returns Transformed usage data entry or null if parsing failed
 */
export async function parseDroidSession(
	sessionPath: string,
	sessionId: string,
	_options: LoadOptions = {},
): Promise<any | null> {
	logger.debug(`Parsing droid session ${sessionId} from ${sessionPath}`);
	const jsonlPath = path.join(sessionPath, `${sessionId}.jsonl`);
	const settingsPath = path.join(sessionPath, `${sessionId}.settings.json`);

	// Check if both files exist
	if (!isFileSync(jsonlPath) || !isFileSync(settingsPath)) {
		logger.debug(`Missing droid session files for ${sessionId}: jsonl=${isFileSync(jsonlPath)}, settings=${isFileSync(settingsPath)}`);
		return null;
	}

	try {
		// Parse settings file
		const settingsResult = await Result.try({
			try: async () => {
				const settingsContent = await readFile(settingsPath, 'utf-8');
				return JSON.parse(settingsContent) as unknown;
			},
			catch: error => error,
		})();

		if (Result.isFailure(settingsResult)) {
			logger.warn(`Failed to parse droid settings file ${settingsPath}: ${String(settingsResult.error) ?? 'Unknown error'}`);
			return null;
		}

		const settingsParseResult = v.safeParse(droidSettingsSchema, settingsResult.value);
		if (!settingsParseResult.success) {
			logger.warn(`Invalid droid settings format in ${settingsPath}`);
			return null;
		}

		const settings = settingsParseResult.output;

		// Parse JSONL file to get session start info
		const sessionResult = await Result.try({
			try: async () => {
				const jsonlContent = await readFile(jsonlPath, 'utf-8');
				const lines = jsonlContent.trim().split('\n');
				if (lines.length === 0) {
					throw new Error('Empty JSONL file');
				}
				return JSON.parse(lines[0] ?? '{}') as unknown; // First line should contain session start
			},
			catch: error => error,
		})();

		if (Result.isFailure(sessionResult)) {
			logger.warn(`Failed to parse droid session file ${jsonlPath}: ${String(sessionResult.error) ?? 'Unknown error'}`);
			return null;
		}

		const sessionParseResult = v.safeParse(droidSessionStartSchema, sessionResult.value);
		if (!sessionParseResult.success) {
			logger.warn(`Invalid droid session format in ${jsonlPath}`);
			return null;
		}

		const sessionStart = sessionParseResult.output;

		// Extract usage data
		const tokenUsage = settings.tokenUsage;
		if (tokenUsage == null) {
			logger.debug(`No token usage data found in ${settingsPath}`);
			return null;
		}

		// Get model from provider mapping
		const model = mapProviderToModel(settings.providerLock, settings.apiProviderLock);

		// Create date from session start (use settings timestamp if available, otherwise file modification time)
		let timestamp: string;
		if (settings.providerLockTimestamp != null) {
			timestamp = settings.providerLockTimestamp;
		}
		else {
			// Use file modification time as a fallback to get actual session date
			try {
				const fileStats = await stat(settingsPath);
				timestamp = fileStats.mtime.toISOString();
				logger.debug(`Using file modification time for droid session ${sessionId}: ${timestamp}`);
			}
			catch (error) {
				logger.warn(`Failed to get file stats for ${settingsPath}, using current time: ${String(error)}`);
				timestamp = new Date().toISOString();
			}
		}

		// Extract project from session title or fallback to session id
		let projectName = sessionId;
		if (sessionStart.title != null) {
			// Extract project path from title if it contains one
			const pathMatch = sessionStart.title?.match(/(?:for|in)?\s*([A-Z]:\\[^\\].*?|\.[^.\s].*?)(?:\s|$)/i);
			if (pathMatch?.[1]) {
				projectName = path.basename(pathMatch[1]);
			}
		}

		// Transform to better-ccusage format
		const transformedEntry = {
			timestamp,
			sessionId: createSessionId(sessionId),
			version: '1.0.0', // Default version
			message: {
				usage: {
					input_tokens: tokenUsage.inputTokens,
					output_tokens: tokenUsage.outputTokens,
					cache_creation_input_tokens: tokenUsage.cacheCreationTokens,
					cache_read_input_tokens: tokenUsage.cacheReadTokens,
				},
				model,
				id: sessionId, // Use session id as message id for droid
			},
			// Cost will be calculated by better-ccusage based on model pricing
			requestId: sessionId, // Use session id as request id for droid
			cwd: `/droid/${projectName}`, // Virtual working directory for droid
			source: 'droid' as const, // Mark as droid source
		};

		logger.debug(`Successfully parsed droid session ${sessionId} with model ${transformedEntry.message.model} and source ${transformedEntry.source}`);
		return transformedEntry;
	}
	catch (error) {
		logger.warn(`Error processing droid session ${sessionId}: ${String(error)}`);
		return null;
	}
}

/**
 * Get the default droid sessions path
 * @returns Path to droid sessions directory
 */
export function getDroidPath(): string {
	const defaultPath = path.join(USER_HOME_DIR, DEFAULT_DROID_SESSIONS_PATH);

	// Return default path even if it doesn't exist (will be handled by caller)
	return defaultPath;
}

/**
 * Find all droid session directories
 * @param droidPath - Path to droid sessions directory
 * @returns Array of session directory paths
 */
export function findDroidSessions(droidPath: string): string[] {
	logger.debug(`Finding droid sessions in ${droidPath}`);
	if (!isDirectorySync(droidPath)) {
		logger.debug(`Droid path ${droidPath} is not a directory`);
		return [];
	}

	// Look for both subdirectories (old structure) and flat files (current structure)
	const sessionDirs = globSync(['*/'], {
		cwd: droidPath,
		onlyDirectories: true,
		absolute: false,
	}).map((dir: string) => path.join(droidPath, dir));

	// Also look for flat .jsonl files to handle current droid structure
	const jsonlFiles = globSync(['*.jsonl'], {
		cwd: droidPath,
		onlyFiles: true,
		absolute: false,
	});

	logger.debug(`Found ${sessionDirs.length} subdirectories and ${jsonlFiles.length} JSONL files`);

	// Convert flat files to pseudo-directories for the session ID
	const flatSessions = jsonlFiles
		.map((file: string) => {
			const sessionId = file.replace('.jsonl', '');
			const settingsFile = `${sessionId}.settings.json`;

			logger.debug(`Processing JSONL file ${file}, checking for settings file ${settingsFile}`);

			// Check if corresponding settings file exists
			if (globSync([settingsFile], { cwd: droidPath, onlyFiles: true }).length > 0) {
				logger.debug(`Found matching settings file for session ${sessionId}`);
				return droidPath; // Return the base path for flat structure
			}
			logger.debug(`No settings file found for session ${sessionId}`);
			return null;
		})
		.filter((path: string | null): path is string => path !== null);

	// Remove duplicates and combine both structures
	const allSessions = [...new Set([...sessionDirs, ...flatSessions])];
	logger.debug(`Found ${allSessions.length} total sessions: ${allSessions.slice(0, 3).join(', ')}${allSessions.length > 3 ? '...' : ''}`);
	return allSessions;
}

/**
 * Process all droid sessions in a directory
 * @param droidPath - Path to droid sessions directory
 * @param options - Load options for processing
 * @returns Array of transformed usage data entries
 */
export async function processDroidSessions(
	droidPath: string,
	options: LoadOptions = {},
): Promise<any[]> {
	logger.debug(`Processing droid sessions from ${droidPath}`);
	const sessionDirs = findDroidSessions(droidPath);
	logger.debug(`Found ${sessionDirs.length} session directories: ${sessionDirs.slice(0, 3).join(', ')}${sessionDirs.length > 3 ? '...' : ''}`);
	const results: any[] = [];
	const processedSessionIds = new Set<string>();

	for (const sessionDir of sessionDirs) {
		// Check if this is a subdirectory (old structure) or flat file (new structure)
		if (sessionDir === droidPath) {
			// Flat file structure - find all .jsonl files and extract session IDs
			const jsonlFiles = globSync(['*.jsonl'], {
				cwd: droidPath,
				onlyFiles: true,
				absolute: false,
			});

			for (const jsonlFile of jsonlFiles) {
				const sessionId = jsonlFile.replace('.jsonl', '');
				if (!processedSessionIds.has(sessionId)) {
					const entry = await parseDroidSession(droidPath, sessionId, options);
					if (entry != null) {
						results.push(entry);
						processedSessionIds.add(sessionId);
					}
				}
			}
		}
		else {
			// Subdirectory structure (old format)
			const sessionId = path.basename(sessionDir);
			if (!processedSessionIds.has(sessionId)) {
				const entry = await parseDroidSession(sessionDir, sessionId, options);
				if (entry != null) {
					results.push(entry);
					processedSessionIds.add(sessionId);
				}
			}
		}
	}

	return results;
}

// Test suite for droid adapter
if (import.meta.vitest != null) {
	const { describe, it, expect, beforeEach } = await import('vitest');
	const { createFixture } = await import('fs-fixture');

	describe('parseDroidSession', () => {
		let fixture: any;

		beforeEach(async () => {
			fixture = await createFixture();
		});

		it('should parse valid droid session with anthropic provider', async () => {
			const sessionId = 'test-session-1';

			const testFixture = await createFixture({
				[sessionId]: {
					[`${sessionId}.jsonl`]: JSON.stringify({
						type: 'session_start',
						id: sessionId,
						title: 'for the project D:\\Dev\\test how to fix this UI',
						owner: 'testuser',
					}),
					[`${sessionId}.settings.json`]: JSON.stringify({
						assistantActiveTimeMs: 3600000,
						providerLock: 'anthropic',
						providerLockTimestamp: '2025-01-01T12:00:00Z',
						tokenUsage: {
							inputTokens: 1000,
							outputTokens: 500,
							cacheCreationTokens: 100,
							cacheReadTokens: 50,
							thinkingTokens: 0,
						},
					}),
				},
			});

			const sessionDir = `${testFixture.path}/${sessionId}`;
			const result = await parseDroidSession(sessionDir, sessionId);

			expect(result).not.toBeNull();
			expect(result?.source).toBe('droid');
			expect(result?.sessionId).toBe(sessionId);
			expect(result?.message.model).toBe('sonnet-4-5');
			expect(result?.message.usage.input_tokens).toBe(1000);
			expect(result?.message.usage.output_tokens).toBe(500);
			expect(result?.cwd).toBe('/droid/test-session-1');
		});

		it('should parse droid session with openai provider', async () => {
			const sessionId = 'test-session-2';

			const testFixture = await createFixture({
				[sessionId]: {
					[`${sessionId}.jsonl`]: JSON.stringify({
						type: 'session_start',
						id: sessionId,
						title: 'test session',
					}),
					[`${sessionId}.settings.json`]: JSON.stringify({
						providerLock: 'openai',
						apiProviderLock: 'baseten',
						tokenUsage: {
							inputTokens: 2000,
							outputTokens: 1000,
							cacheCreationTokens: 0,
							cacheReadTokens: 0,
							thinkingTokens: 0,
						},
					}),
				},
			});

			const sessionDir = `${testFixture.path}/${sessionId}`;
			const result = await parseDroidSession(sessionDir, sessionId);

			expect(result?.message.model).toBe('gpt-5');
			expect(result?.message.usage.input_tokens).toBe(2000);
		});

		it('should parse droid session with generic API provider', async () => {
			const sessionId = 'test-session-3';

			const testFixture = await createFixture({
				[sessionId]: {
					[`${sessionId}.jsonl`]: JSON.stringify({
						type: 'session_start',
						id: sessionId,
					}),
					[`${sessionId}.settings.json`]: JSON.stringify({
						providerLock: 'openai',
						apiProviderLock: 'generic-chat-completion-api',
						tokenUsage: {
							inputTokens: 500,
							outputTokens: 250,
							cacheCreationTokens: 0,
							cacheReadTokens: 0,
							thinkingTokens: 0,
						},
					}),
				},
			});

			const sessionDir = `${testFixture.path}/${sessionId}`;
			const result = await parseDroidSession(sessionDir, sessionId);

			expect(result?.message.model).toBe('glm-4.6');
		});

		it('should return null for missing files', async () => {
			const sessionId = 'test-session-missing';

			const testFixture = await createFixture({}); // Empty fixture
			const sessionDir = `${testFixture.path}/${sessionId}`;

			const result = await parseDroidSession(sessionDir, sessionId);
			expect(result).toBeNull();
		});

		it('should return null for invalid JSON', async () => {
			const sessionId = 'test-session-invalid';

			const testFixture = await createFixture({
				[sessionId]: {
					[`${sessionId}.settings.json`]: 'invalid json',
				},
			});

			const sessionDir = `${testFixture.path}/${sessionId}`;
			const result = await parseDroidSession(sessionDir, sessionId);
			expect(result).toBeNull();
		});
	});

	describe('processDroidSessions', () => {
		it('should process multiple droid sessions', async () => {
			const sessions = [
				{ id: 'session-1', provider: 'anthropic', input: 1000, output: 500 },
				{ id: 'session-2', provider: 'openai', input: 2000, output: 1000 },
			];

			// Create fixture with session structure
			const fixtureStructure: any = {};
			for (const session of sessions) {
				fixtureStructure[session.id] = {
					[`${session.id}.jsonl`]: JSON.stringify({
						type: 'session_start',
						id: session.id,
					}),
					[`${session.id}.settings.json`]: JSON.stringify({
						providerLock: session.provider,
						tokenUsage: {
							inputTokens: session.input,
							outputTokens: session.output,
							cacheCreationTokens: 0,
							cacheReadTokens: 0,
							thinkingTokens: 0,
						},
					}),
				};
			}

			const fixture = await createFixture(fixtureStructure);
			const results = await processDroidSessions(fixture.path);

			expect(results).toHaveLength(2);
			expect(results[0].message.model).toBe('sonnet-4-5');
			expect(results[1].message.model).toBe('gpt-5');
			expect(results[0].source).toBe('droid');
			expect(results[1].source).toBe('droid');
		});
	});

	describe('mapProviderToModel', () => {
		it('should map anthropic provider to sonnet-4-5', async () => {
			// Test the internal function through parseDroidSession
			const sessionId = 'test-anthropic';

			const testFixture = await createFixture({
				[sessionId]: {
					[`${sessionId}.jsonl`]: JSON.stringify({
						type: 'session_start',
						id: sessionId,
					}),
					[`${sessionId}.settings.json`]: JSON.stringify({
						providerLock: 'anthropic',
						tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 },
					}),
				},
			});

			const sessionDir = `${testFixture.path}/${sessionId}`;
			const result = await parseDroidSession(sessionDir, sessionId);
			expect(result?.message.model).toBe('sonnet-4-5');
		});
	});
}
