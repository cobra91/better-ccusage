# OpenCode Usage Tracking

better-ccusage provides usage tracking for [OpenCode](https://github.com/sst/opencode), a terminal-based AI coding assistant. This allows you to monitor token usage and costs when using OpenCode with various AI providers.

## Installation

```bash
# Install the opencode package
pnpm add @better-ccusage/opencode

# Or use directly with npx
pnpm dlx @better-ccusage/opencode daily
```

## Usage

### Daily Reports

```bash
pnpm dlx @better-ccusage/opencode daily
```

Shows token usage and costs aggregated by day.

### Weekly Reports

```bash
pnpm dlx @better-ccusage/opencode weekly
```

Shows usage aggregated by ISO week (format: `YYYY-Www`).

### Monthly Reports

```bash
pnpm dlx @better-ccusage/opencode monthly
```

Shows usage aggregated by month (format: `YYYY-MM`).

### Session Reports

```bash
pnpm dlx @better-ccusage/opencode session
```

Shows usage grouped by session, with subagent hierarchy displayed.

## Command Options

| Option        | Short | Description                            |
| ------------- | ----- | -------------------------------------- |
| `--breakdown` | `-b`  | Show per-model cost breakdown          |
| `--compact`   |       | Force compact mode for narrow displays |

## Data Location

OpenCode stores its data in:

- **Messages**: `~/.local/share/opencode/storage/message/{sessionID}/msg_{id}.json`
- **Sessions**: `~/.local/share/opencode/storage/session/{sessionID}.json`

### Custom Data Directory

You can override the data directory using environment variables:

```bash
# Use custom data directory
export OPENCODE_DATA_DIR=/custom/path/to/opencode

# Or use XDG Base Directory specification
export XDG_DATA_HOME=/custom/xdg/data
```

## Supported Models

OpenCode supports various AI providers. better-ccusage automatically detects and calculates costs for:

- **Anthropic**: Claude models (claude-sonnet-4, claude-opus-4, etc.)
- **Google**: Gemini models
- **OpenAI**: GPT models
- **Other providers**: Any model in the pricing database

### Model Aliases

Some OpenCode-specific model names are automatically mapped to standard pricing names:

| OpenCode Name       | Pricing Database Name    |
| ------------------- | ------------------------ |
| `gemini-3-pro-high` | `gemini-3-pro-preview`   |
| `gemini-2.5-pro`    | `gemini-2.5-pro-preview` |

## Key Differences from Claude Code

| Feature               | Claude Code               | OpenCode                            |
| --------------------- | ------------------------- | ----------------------------------- |
| **Data Format**       | JSONL files               | JSON files                          |
| **Storage Location**  | `~/.claude/projects/`     | `~/.local/share/opencode/storage/`  |
| **Cost Calculation**  | Pre-calculated `costUSD`  | Often needs calculation from tokens |
| **Subagent Tracking** | Via `parentID` in entries | Via `parentID` in session metadata  |

## Output Format

### Table Output

Default output shows a formatted table with:

- Date/Week/Month or Session ID
- Source (opencode)
- Models used
- Input/Output tokens
- Cache creation/read tokens
- Total tokens
- Cost (USD)

### Example

```
┌────────────┬──────────┬────────┬───────┬────────┬──────────────┬────────────┬──────────────┬────────────┐
│ Date       │ Source   │ Models │ Input │ Output │ Cache Create │ Cache Read │ Total Tokens │ Cost (USD) │
├────────────┼──────────┼────────┼───────┼────────┼──────────────┼────────────┼──────────────┼────────────┤
│ 2026-02-14 │ opencode │ claude │ 1,234 │ 567    │ 100          │ 50         │ 1,951        │ $0.0234    │
└────────────┴──────────┴────────┴───────┴────────┴──────────────┴────────────┴──────────────┴────────────┘
```

## Library Usage

You can also use the package programmatically:

```typescript
import { loadDailyUsageData, loadMonthlyUsageData, loadWeeklyUsageData } from '@better-ccusage/opencode/data-loader';

// Load daily usage data
const dailyData = await loadDailyUsageData();
console.log(dailyData);

// Load weekly usage data
const weeklyData = await loadWeeklyUsageData();
console.log(weeklyData);

// Load monthly usage data
const monthlyData = await loadMonthlyUsageData();
console.log(monthlyData);
```

## Related

- [Daily Reports](/guide/daily-reports.md)
- [Weekly Reports](/guide/weekly-reports.md)
- [Monthly Reports](/guide/monthly-reports.md)
- [Session Reports](/guide/session-reports.md)
