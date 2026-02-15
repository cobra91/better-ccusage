# CLAUDE.md - OpenCode Package

This package provides usage analysis for OpenCode AI assistant.

## Package Overview

**Name**: `@better-ccusage/opencode`
**Description**: Usage analysis tool for OpenCode AI assistant
**Type**: CLI tool and library with TypeScript exports

## Data Location

OpenCode stores data in:

- Messages: `~/.local/share/opencode/storage/message/{sessionID}/msg_{id}.json`
- Sessions: `~/.local/share/opencode/storage/session/{sessionID}.json`

Override with `OPENCODE_DATA_DIR` or `XDG_DATA_HOME` environment variables.

## Development Commands

**Build:**

- `pnpm run build` - Build distribution files with tsdown

**Development Usage:**

- `pnpm tsx src/index.ts daily` - Show daily usage report
- `pnpm tsx src/index.ts weekly` - Show weekly usage report (ISO format)
- `pnpm tsx src/index.ts monthly` - Show monthly usage report
- `pnpm tsx src/index.ts session` - Show session-based usage report

## Architecture

**Key Modules:**

- `src/index.ts` - CLI entry point
- `src/data-loader.ts` - Loads and parses OpenCode JSON files
- `src/cost-utils.ts` - Cost calculation utilities with model aliases
- `src/logger.ts` - Logging utilities
- `src/commands/` - CLI subcommands (daily, weekly, monthly, session)

**Data Flow:**

1. Loads JSON files from OpenCode storage directory
2. Parses messages with Valibot schemas
3. Aggregates usage data by time periods or sessions
4. Calculates costs using pricing database
5. Outputs formatted tables

## Key Differences from Claude Code

| Aspect | Claude Code | OpenCode |
| -------- | ------------- | ---------- |
| **Format** | JSONL | JSON files |
| **Location** | `~/.claude/projects/` | `~/.local/share/opencode/storage/` |
| **Cost** | Pre-calculated `costUSD` | Often `cost: 0` (calculated from tokens) |
| **Subagents** | Via `parentID` in entries | Via `parentID` in session metadata |

## Code Style

Follow the same conventions as better-ccusage:

- Use `.ts` extensions for local imports
- Prefer `@praha/byethrow Result` type over try-catch
- Only export what's actually used
- Dependencies in `devDependencies`
