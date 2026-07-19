# Environment Variables

better-ccusage supports several environment variables for configuration and customization. Environment variables provide a way to configure better-ccusage without modifying command-line arguments or configuration files.

## CLAUDE_CONFIG_DIR

Specifies where better-ccusage should look for Claude Code data. This is the most important environment variable for better-ccusage.

### Single Directory

Set a single custom Claude data directory:

```bash
export CLAUDE_CONFIG_DIR="/path/to/your/claude/data"
better-ccusage daily
```

### Multiple Directories

Set multiple directories (comma-separated) to aggregate data from multiple sources:

```bash
export CLAUDE_CONFIG_DIR="/path/to/claude1,/path/to/claude2"
better-ccusage daily
```

When multiple directories are specified, better-ccusage automatically aggregates usage data from all valid locations.

### Default Behavior

When `CLAUDE_CONFIG_DIR` is not set, better-ccusage automatically searches in:

1. `~/.config/claude/projects/` (new default, Claude Code v1.0.30+)
2. `~/.claude/projects/` (legacy location, pre-v1.0.30)

Data from all valid directories is automatically combined.

::: info Directory Change
The directory change from `~/.claude` to `~/.config/claude` in Claude Code v1.0.30 was an undocumented breaking change. better-ccusage handles both locations automatically for backward compatibility.
:::

### Use Cases

#### Development Environment

```bash
# Set in your shell profile (.bashrc, .zshrc, config.fish)
export CLAUDE_CONFIG_DIR="$HOME/.config/claude"
```

#### Multiple Claude Installations

```bash
# Aggregate data from different Claude installations
export CLAUDE_CONFIG_DIR="$HOME/.claude,$HOME/.config/claude"
```

#### Team Shared Directory

```bash
# Use team-shared data directory
export CLAUDE_CONFIG_DIR="/team-shared/claude-data/$USER"
```

#### CI/CD Environment

```bash
# Use specific directory in CI pipeline
export CLAUDE_CONFIG_DIR="/ci-data/claude-logs"
better-ccusage daily --json > usage-report.json
```

## ZCODE_HOME

Specifies the ZCode home directory where better-ccusage should look for the usage SQLite database (`cli/db/db.sqlite`).

```bash
export ZCODE_HOME="/path/to/your/zcode/home"
better-ccusage daily
```

When `ZCODE_HOME` is not set, better-ccusage automatically looks in:

- **Linux/macOS**: `~/.zcode/cli/db/db.sqlite`
- **Windows**: `C:\Users\<user>\.zcode\cli\db\db.sqlite`

ZCode (the official GLM coding tool) records every model request in this database, so better-ccusage reads it directly — no manual export needed. The database is opened **read-only**, so it never interferes with a running ZCode process.

::: tip Node.js requirement
Reading the ZCode database requires Node.js `>=22.13.0` (when the built-in `node:sqlite` module stopped requiring the `--experimental-sqlite` flag). On older Node versions or alternative runtimes (e.g. Bun), ZCode data is silently skipped and Claude/Droid usage continues to work normally.
:::

## DROID_SESSIONS_DIR

Specifies the directory where Factory/Droid stores its session data.

```bash
export DROID_SESSIONS_DIR="/path/to/your/factory/sessions"
better-ccusage daily
```

When not set, better-ccusage looks in `~/.factory/sessions` by default.

## CODEX_HOME

Overrides the OpenAI Codex CLI home directory. `better-ccusage` reads session JSONL logs from `<CODEX_HOME>/sessions` (recursively, matching `**/*.jsonl`).

```bash
export CODEX_HOME="/path/to/your/codex/home"
better-ccusage daily
```

When not set, the default is `~/.codex` (so sessions are read from `~/.codex/sessions`).

::: tip
Interactive Codex TUI sessions do not write per-turn `token_count` events to disk — only `codex exec` (non-interactive) does. If your Codex usage is missing, run `better-ccusage codex daily` and check the diagnostic warning. See [openai/codex#9660](https://github.com/openai/codex/issues/9660) for background.
:::

## OPENCODE_DATA_DIR

Overrides the OpenCode data directory. `better-ccusage` reads the `opencode.db` SQLite database from this directory.

```bash
export OPENCODE_DATA_DIR="/path/to/your/opencode"
better-ccusage daily
```

When not set, the default is `~/.local/share/opencode`.

## DEVIN_DATA_DIR

Specifies the Devin CLI data directory where better-ccusage should look for ATIF trajectory transcripts (`transcripts/*.json`) and the optional `sessions.db` enrichment database.

```bash
export DEVIN_DATA_DIR="/path/to/your/devin/cli"
better-ccusage daily
```

When `DEVIN_DATA_DIR` is not set, better-ccusage automatically looks in:

- **Linux/macOS**: `~/.local/share/devin/cli/`
- **Windows**: `%APPDATA%\devin\cli\`

See the [Devin usage guide](/guide/devin.md) for details on token semantics, hidden-session filtering, and the ATIF transcript format.

## PI_AGENT_DIR

Specifies the pi/oh-my-pi (omp) sessions directory(ies) where better-ccusage should look for JSONL session files. Supports a comma-separated list for multiple directories.

```bash
# Single directory
export PI_AGENT_DIR="/path/to/your/pi/sessions"
better-ccusage daily

# Multiple directories
export PI_AGENT_DIR="/path/to/pi,/path/to/omp"
better-ccusage daily
```

When `PI_AGENT_DIR` is not set, better-ccusage **auto-detects** both default directories (scanning whichever exist):

- **pi**: `~/.pi/agent/sessions/`
- **oh-my-pi (omp)**: `~/.omp/agent/sessions/`

Setting `PI_AGENT_DIR` overrides auto-detection and scans only the listed directories. Entries are deduplicated, so a session present in both directories is counted once. See the [pi usage guide](/guide/pi.md) for details on token semantics and the JSONL format.

## LOG_LEVEL

Controls the verbosity of log output. better-ccusage uses [consola](https://github.com/unjs/consola) for logging under the hood.

### Log Levels

| Level  | Value | Description                  | Use Case               |
| ------ | ----- | ---------------------------- | ---------------------- |
| Silent | `0`   | Errors only                  | Scripts, piping output |
| Warn   | `1`   | Warnings and errors          | CI/CD environments     |
| Log    | `2`   | Normal logs                  | General use            |
| Info   | `3`   | Informational logs (default) | Standard operation     |
| Debug  | `4`   | Debug information            | Troubleshooting        |
| Trace  | `5`   | All operations               | Deep debugging         |

### Usage Examples

```bash
# Silent mode - only show results
LOG_LEVEL=0 better-ccusage daily

# Warning level - for CI/CD
LOG_LEVEL=1 better-ccusage monthly

# Debug mode - troubleshooting
LOG_LEVEL=4 better-ccusage session

# Trace everything - deep debugging
LOG_LEVEL=5 better-ccusage blocks
```

### Practical Applications

#### Clean Output for Scripts

```bash
# Get clean JSON output without logs
LOG_LEVEL=0 better-ccusage daily --json | jq '.summary.totalCost'
```

#### CI/CD Pipeline

```bash
# Show only warnings and errors in CI
LOG_LEVEL=1 better-ccusage daily --instances
```

#### Debugging Issues

```bash
# Maximum verbosity for troubleshooting
LOG_LEVEL=5 better-ccusage daily --debug
```

#### Piping Output

```bash
# Silent logs when piping to other commands
LOG_LEVEL=0 better-ccusage monthly --json | python analyze.py
```

## Additional Environment Variables

### NO_COLOR

Disable colored output (standard CLI convention):

```bash
export NO_COLOR=1
better-ccusage daily  # No color formatting
```

### FORCE_COLOR

Force colored output even when piping:

```bash
export FORCE_COLOR=1
better-ccusage daily | less -R  # Preserves colors
```

## Setting Environment Variables

### Temporary (Current Session)

```bash
# Set for single command
LOG_LEVEL=0 better-ccusage daily

# Set for current shell session
export CLAUDE_CONFIG_DIR="/custom/path"
better-ccusage daily
```

### Permanent (Shell Profile)

Add to your shell configuration file:

#### Bash (~/.bashrc)

```bash
export CLAUDE_CONFIG_DIR="$HOME/.config/claude"
export LOG_LEVEL=3
```

#### Zsh (~/.zshrc)

```zsh
export CLAUDE_CONFIG_DIR="$HOME/.config/claude"
export LOG_LEVEL=3
```

#### Fish (~/.config/fish/config.fish)

```fish
set -x CLAUDE_CONFIG_DIR "$HOME/.config/claude"
set -x LOG_LEVEL 3
```

#### PowerShell (Profile.ps1)

```powershell
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.config\claude"
$env:LOG_LEVEL = "3"
```

## Precedence

Environment variables have lower precedence than command-line arguments but higher than configuration files:

1. **Command-line arguments** (highest priority)
2. **Environment variables**
3. **Configuration files**
4. **Built-in defaults** (lowest priority)

Example:

```bash
# Environment variable sets log level
export LOG_LEVEL=1

# But command-line argument overrides it
better-ccusage daily --debug  # Shows debug output
```

## Debugging

To see which environment variables are being used:

```bash
# Show all environment variables
env | grep -E "CLAUDE|CCUSAGE|LOG_LEVEL"

# Debug mode shows environment variable usage
LOG_LEVEL=4 better-ccusage daily --debug
```

## Related Documentation

- [Command-Line Options](/guide/cli-options) - CLI arguments and flags
- [Configuration Files](/guide/config-files) - JSON configuration files
- [Configuration Overview](/guide/configuration) - Complete configuration guide
