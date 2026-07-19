import { homedir } from 'node:os';
import path from 'node:path';
import { xdgConfig } from 'xdg-basedir';

/**
 * Default number of recent days to include when filtering blocks
 * Used in both session blocks and commands for consistent behavior
 */
export const DEFAULT_RECENT_DAYS = 3;

/**
 * Threshold percentage for showing usage warnings in blocks command (80%)
 * When usage exceeds this percentage of limits, warnings are displayed
 */
export const BLOCKS_WARNING_THRESHOLD = 0.8;

/**
 * Terminal width threshold for switching to compact display mode in blocks command
 * Below this width, tables use more compact formatting
 */
export const BLOCKS_COMPACT_WIDTH_THRESHOLD = 120;

/**
 * Default terminal width when stdout.columns is not available in blocks command
 * Used as fallback for responsive table formatting
 */
export const BLOCKS_DEFAULT_TERMINAL_WIDTH = 120;

/**
 * Threshold percentage for considering costs as matching (0.1% tolerance)
 * Used in debug cost validation to allow for minor calculation differences
 */
export const DEBUG_MATCH_THRESHOLD_PERCENT = 0.1;

/**
 * User's home directory path
 * Centralized access to OS home directory for consistent path building
 */
export const USER_HOME_DIR = homedir();

/**
 * XDG config directory path
 * Uses XDG_CONFIG_HOME if set, otherwise falls back to ~/.config
 */
const XDG_CONFIG_DIR = xdgConfig ?? path.join(USER_HOME_DIR, '.config');

/**
 * Canonical order of usage data sources.
 *
 * Single source of truth for the source enumeration. Drives both
 * `combineSources()` (canonical ordering of grouped labels) and the valibot
 * `sourceSchema` picklist (via `SOURCE_SUBSETS`). Add a new source here and
 * both the combiner and the schema pick up the extra atom automatically.
 */
export const SOURCE_ORDER = ['claude', 'droid', 'zcode', 'codex', 'opencode', 'devin'] as const;

/**
 * Display labels for each source atom, matching the canonical capitalization
 * used across the README, adapter logs, and docs (e.g. "OpenCode", "ZCode" —
 * not "Opencode"/"Zcode"). Used for user-facing messages such as the
 * "No <Source> usage data found." empty-result warning.
 */
const SOURCE_LABELS: Record<string, string> = {
	claude: 'Claude',
	droid: 'Droid',
	zcode: 'ZCode',
	codex: 'Codex',
	opencode: 'OpenCode',
	devin: 'Devin',
};

/**
 * Return the display label for a source atom, defaulting to "Claude" when no
 * source filter is set (the aggregate case). Unknown values pass through
 * unchanged so a typo never produces an empty label.
 */
export function sourceLabel(source?: string): string {
	return source != null ? (SOURCE_LABELS[source] ?? source) : 'Claude';
}

/**
 * All non-empty subsets of {@link SOURCE_ORDER}, joined by '/' in canonical
 * order. Generated at module load so the list stays in sync with
 * `SOURCE_ORDER` (2^n - 1 combinations for n sources).
 *
 * Enumeration order: for atoms [a, b, c, ...] we emit `a` and `a/` prepended
 * to each subset of the tail first, then the subsets of the tail. This keeps
 * every source's atom contiguous and matches the order the previous hand-
 * written picklist used (all subsets containing the first atom, then those
 * without), so existing snapshots/debug output are unchanged.
 *
 * The runtime array always contains the exact subset strings, so valibot's
 * `picklist` still validates values precisely. Note the branded `Source` type
 * widens to `string & Brand<'Source'>` (no literal union) because the
 * generated array is not a literal tuple — no consumer relies on literal
 * narrowing, and the validation boundary stays exact.
 */
function generateSourceSubsets(atoms: readonly string[]): readonly string[] {
	const [first, ...rest] = atoms;
	if (first === undefined) {
		return [];
	}
	const tailSubsets = generateSourceSubsets(rest);
	const withFirst = [first, ...tailSubsets.map(s => `${first}/${s}`)];
	return [...withFirst, ...tailSubsets];
}

// SOURCE_ORDER is guaranteed non-empty, so the result is a non-empty tuple.
// Cast at the export boundary so valibot's `picklist` (which rejects a widened
// `string[]`) accepts it; the helper itself stays honestly typed.
export const SOURCE_SUBSETS = generateSourceSubsets(SOURCE_ORDER) as unknown as readonly [string, ...string[]];

/**
 * Default Claude data directory path (~/.claude)
 * Used as base path for loading usage data from JSONL files
 */
export const DEFAULT_CLAUDE_CODE_PATH = '.claude';

/**
 * Default Claude data directory path using XDG config directory
 * Uses XDG_CONFIG_HOME if set, otherwise falls back to ~/.config/claude
 */
export const DEFAULT_CLAUDE_CONFIG_PATH = path.join(XDG_CONFIG_DIR, 'claude');

/**
 * Environment variable for specifying multiple Claude data directories
 * Supports comma-separated paths for multiple locations
 */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/**
 * Environment variable for specifying droid sessions directory
 * Allows users to specify custom path to droid session data
 */
export const DROID_SESSIONS_DIR_ENV = 'DROID_SESSIONS_DIR';

/**
 * Default droid sessions directory path
 * Uses user's .factory/sessions
 */
export const DEFAULT_DROID_SESSIONS_PATH = `.factory/sessions`;

/**
 * Environment variable for overriding the ZCode home directory.
 * When set, the usage database is resolved relative to it.
 */
export const ZCODE_HOME_ENV = 'ZCODE_HOME';

/**
 * Default ZCode home directory: `~/.zcode` (Windows: `C:\Users\<user>\.zcode`).
 */
export const DEFAULT_ZCODE_HOME_PATH = '.zcode';

/**
 * Subpath of the SQLite database that stores ZCode model usage, relative to
 * the ZCode home directory.
 */
export const DEFAULT_ZCODE_DB_SUBPATH = path.join('cli', 'db', 'db.sqlite');

/**
 * Environment variable for overriding the OpenAI Codex CLI home directory.
 * When set, the sessions directory is resolved relative to it.
 */
export const CODEX_HOME_ENV = 'CODEX_HOME';

/**
 * Default Codex home directory: `~/.codex`.
 */
export const DEFAULT_CODEX_HOME_PATH = '.codex';

/**
 * Subpath of the sessions directory that stores Codex JSONL logs, relative
 * to the Codex home directory.
 */
export const DEFAULT_CODEX_SESSIONS_SUBPATH = 'sessions';

/**
 * JSONL file glob pattern for finding Codex session files (recursive).
 */
export const CODEX_SESSION_GLOB = '**/*.jsonl';

/**
 * Environment variable for overriding the OpenCode data directory.
 * Modern OpenCode stores sessions in a SQLite database (opencode.db) under
 * this directory.
 */
export const OPENCODE_DATA_DIR_ENV = 'OPENCODE_DATA_DIR';

/**
 * Default OpenCode data directory: `~/.local/share/opencode` (XDG-style).
 */
export const DEFAULT_OPENCODE_HOME_PATH = path.join('.local', 'share', 'opencode');

/**
 * Subpath of the SQLite database that stores OpenCode messages/sessions,
 * relative to the OpenCode data directory.
 */
export const DEFAULT_OPENCODE_DB_SUBPATH = 'opencode.db';

/**
 * Environment variable for overriding the Devin CLI data directory.
 *
 * Devin stores ATIF trajectory transcripts under `<data dir>/transcripts/`
 * and an optional `sessions.db` (SQLite) at the data dir root. When set, both
 * are resolved relative to this directory.
 */
export const DEVIN_DATA_DIR_ENV = 'DEVIN_DATA_DIR';

/**
 * Default Devin data directory on Linux/macOS (XDG-style share path):
 * `~/.local/share/devin/cli`.
 */
export const DEFAULT_DEVIN_HOME_PATH = path.join('.local', 'share', 'devin', 'cli');

/**
 * Devin data directory on Windows, relative to `%APPDATA%`: `devin\cli`.
 * Used only when `APPDATA` is set; otherwise the Linux/macOS default applies.
 */
export const DEFAULT_DEVIN_HOME_PATH_WIN = path.join('devin', 'cli');

/**
 * Subpath of the directory holding ATIF trajectory transcripts (whole-file
 * JSON, one document per `.json` file), relative to the Devin data directory.
 */
export const DEVIN_TRANSCRIPTS_SUBPATH = 'transcripts';

/**
 * Subpath of the SQLite database that enriches Devin transcripts with the
 * session's working directory, model fallback, and timestamps, and filters
 * hidden sessions. Relative to the Devin data directory.
 */
export const DEVIN_SESSIONS_DB_SUBPATH = 'sessions.db';

/**
 * JSON file glob pattern for finding Devin ATIF transcript files (recursive).
 */
export const DEVIN_TRANSCRIPT_GLOB = '**/*.json';

/**
 * Claude projects directory name within the data directory
 * Contains subdirectories for each project with usage data
 */
export const CLAUDE_PROJECTS_DIR_NAME = 'projects';

/**
 * JSONL file glob pattern for finding usage data files
 * Used to recursively find all JSONL files in project directories
 */
export const USAGE_DATA_GLOB_PATTERN = '**/*.jsonl';

/**
 * Default port for MCP server HTTP transport
 * Used when no port is specified for MCP server communication
 */
export const MCP_DEFAULT_PORT = 8080;

/**
 * Default refresh interval in seconds for live monitoring mode
 * Used in blocks command for real-time updates
 */
export const DEFAULT_REFRESH_INTERVAL_SECONDS = 1;

/**
 * Default refresh interval in seconds for the statusline command.
 * Higher than live monitoring to reduce redundant I/O in active sessions
 * where transcript mtime changes constantly (which would invalidate hybrid cache).
 */
export const DEFAULT_STATUSLINE_REFRESH_INTERVAL_SECONDS = 15;

/**
 * Minimum refresh interval in seconds for live monitoring mode
 * Prevents too-frequent updates that could impact performance
 */
export const MIN_REFRESH_INTERVAL_SECONDS = 1;

/**
 * Maximum refresh interval in seconds for live monitoring mode
 * Prevents too-slow updates that reduce monitoring effectiveness
 */
export const MAX_REFRESH_INTERVAL_SECONDS = 60;

/**
 * Frame rate limit for live monitoring (16ms = ~60fps)
 * Prevents terminal flickering and excessive CPU usage during rapid updates
 */
export const MIN_RENDER_INTERVAL_MS = 16;

/**
 * Burn rate thresholds for indicator display (tokens per minute)
 */
export const BURN_RATE_THRESHOLDS = {
	HIGH: 1000,
	MODERATE: 500,
} as const;

/**
 * Context usage percentage thresholds for color coding
 */
export const DEFAULT_CONTEXT_USAGE_THRESHOLDS = {
	LOW: 50, // Below 50% - green
	MEDIUM: 80, // 50-80% - yellow
	// Above 80% - red
} as const;

/**
 * Days of the week for weekly aggregation
 */
export const WEEK_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/**
 * Week day names type
 */
export type WeekDay = typeof WEEK_DAYS[number];

/**
 * Day of week as number (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
 */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Default configuration file name for storing usage data
 * Used to load and save configuration settings
 */
export const CONFIG_FILE_NAME = 'better-ccusage.json';

/**
 * Default locale for date formatting (en-CA provides YYYY-MM-DD ISO format)
 * Used consistently across the application for date parsing and display
 */
export const DEFAULT_LOCALE = 'en-CA';
