# Directory Detection

better-ccusage automatically detects and manages Claude Code data directories.

## Default Directory Locations

better-ccusage automatically searches for Claude Code data in these locations:

- **`~/.config/claude/projects/`** - New default location (Claude Code v1.0.30+)
- **`~/.claude/projects/`** - Legacy location (pre-v1.0.30)

When no custom directory is specified, better-ccusage searches both locations and aggregates data from all valid directories found.

::: info Breaking Change
The directory change from `~/.claude` to `~/.config/claude` in Claude Code v1.0.30 was an undocumented breaking change. better-ccusage handles both locations automatically to ensure backward compatibility.
:::

## Search Priority

When `CLAUDE_CONFIG_DIR` environment variable is not set, better-ccusage searches in this order:

1. **Primary**: `~/.config/claude/projects/` (preferred for newer installations)
2. **Fallback**: `~/.claude/projects/` (for legacy installations)

Data from all valid directories is automatically combined.

## Custom Directory Configuration

### Single Custom Directory

Override the default search with a specific directory:

```bash
export CLAUDE_CONFIG_DIR="/custom/path/to/claude"
better-ccusage daily
```

### Multiple Directories

Aggregate data from multiple Claude installations:

```bash
export CLAUDE_CONFIG_DIR="/path/to/claude1,/path/to/claude2"
better-ccusage daily
```

## Directory Structure

Claude Code stores usage data in a specific structure:

```
~/.config/claude/projects/
├── project-name-1/
│   ├── session-id-1.jsonl
│   ├── session-id-2.jsonl
│   └── session-id-3.jsonl
├── project-name-2/
│   └── session-id-4.jsonl
└── project-name-3/
    └── session-id-5.jsonl
```

Each:

- **Project directory** represents a different Claude Code project/workspace
- **JSONL file** contains usage data for a specific session
- **Session ID** in the filename matches the `sessionId` field within the file

## Troubleshooting

### No Data Found

If better-ccusage reports no data found:

```bash
# Check if directories exist
ls -la ~/.claude/projects/
ls -la ~/.config/claude/projects/

# Verify environment variable
echo $CLAUDE_CONFIG_DIR

# Test with explicit directory
export CLAUDE_CONFIG_DIR="/path/to/claude"
better-ccusage daily
```

### Permission Errors

```bash
# Check directory permissions
ls -la ~/.claude/
ls -la ~/.config/claude/

# Fix permissions if needed
chmod -R 755 ~/.claude/
chmod -R 755 ~/.config/claude/
```

### Wrong Directory Detection

```bash
# Force specific directory
export CLAUDE_CONFIG_DIR="/exact/path/to/claude"
better-ccusage daily

# Verify which directory is being used
LOG_LEVEL=4 better-ccusage daily
```

## Audit-grade reports (snapshot before resume/compact)

Claude Code rewrites session JSONL files when you `resume` or `compact` a session, and in doing so can drop or rewrite earlier messages. Because better-ccusage reads those files faithfully, totals computed after a rewrite can drift from what you actually used earlier — historical usage that was compacted away is gone from the source.

This is an [upstream Claude Code behavior](https://github.com/anthropics/claude-code/issues/36583), not a better-ccusage bug, and better-ccusage intentionally does not reconstruct a different history (no shadow ledger). For billing reconciliation or audit-grade totals, snapshot the Claude data directory before resuming/compacting long sessions, then point `CLAUDE_CONFIG_DIR` at the snapshot when you need an accurate-as-of-then report:

```bash
# 1. Snapshot the current Claude data (do this before resume/compact)
SNAP="$HOME/claude-snapshots/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SNAP"
cp -r ~/.config/claude/projects "$SNAP/projects"

# 2. Later, run reports against the frozen snapshot
export CLAUDE_CONFIG_DIR="$SNAP"
better-ccusage monthly --breakdown   # totals as of the snapshot date
```

Keep snapshots around for as long as you need auditable numbers; they're plain JSONL files, so they compress well. See [#40](https://github.com/cobra91/better-ccusage/issues/40) for the original field report and repro.

## Related Documentation

- [Environment Variables](/guide/environment-variables) - Configure with CLAUDE_CONFIG_DIR
- [Custom Paths](/guide/custom-paths) - Advanced path management
- [Configuration Overview](/guide/configuration) - Complete configuration guide
