# pi / oh-my-pi Usage Tracking

better-ccusage provides usage tracking for [pi](https://github.com/anthropics/pi) and its widely used fork [oh-my-pi (omp)](https://github.com/oh-my-pi/omp), reading the JSONL session files both CLIs write locally. This lets you monitor token usage and costs across your pi/omp sessions alongside Claude Code, Droid, ZCode, Codex, OpenCode, and Devin — all in one report.

pi/omp support is **built into `better-ccusage`** — there is no separate package to install.

## Usage

pi/omp usage is included automatically in every report. Run any standard command and pi/omp data (when present) appears alongside the other sources:

```bash
# Daily report (all sources, including pi/omp)
npx better-ccusage daily

# With per-model breakdown
npx better-ccusage daily --breakdown

# Monthly, compact mode
npx better-ccusage monthly --compact

# Session view
npx better-ccusage session

# Blocks (5-hour windows)
npx better-ccusage blocks
```

The `Source` column in the output shows `pi` for entries parsed from pi/omp sessions.

## Data Location

Both CLIs write JSONL session files:

- **pi**: `~/.pi/agent/sessions/**/*.jsonl`
- **oh-my-pi (omp)**: `~/.omp/agent/sessions/**/*.jsonl`

When neither `PI_AGENT_DIR` nor a custom path is set, better-ccusage **auto-detects both directories** and scans them together (matches upstream ccusage PR ccusage/ccusage#1338). Entries are deduplicated, so a session file present in both directories is counted once.

### Custom Data Directory

Override the scanned directories with the `PI_AGENT_DIR` environment variable (comma-separated for multiple):

```bash
# Single directory
export PI_AGENT_DIR=/custom/pi/sessions
npx better-ccusage daily

# Multiple directories (comma-separated)
export PI_AGENT_DIR=/custom/pi/sessions,/custom/omp/sessions
npx better-ccusage daily
```

When `PI_AGENT_DIR` is set, the default pi/omp auto-detection is skipped and only the listed directories are scanned.

## Token & Cost Semantics

- **Additive token model**: the four buckets (`input`, `output`, `cacheRead`, `cacheWrite`) are independent and summed. Cached tokens are **not** subtracted from input (unlike Codex, where `input_tokens` include the cached portion). This matches the Claude cost model.
- **`totalTokens` fallback**: when a message's `totalTokens` exceeds the sum of the known buckets, the surplus is folded into `output_tokens` (when output is 0). This matches upstream's `apply_total_token_fallback` and ensures reported token totals account for the full usage.
- **Cost**: pi writes a per-message `cost.total` (USD). The default `auto` cost mode uses it directly; `calculate` mode recomputes from tokens via the shared pricing engine.
- **No model prefix**: per the upstream omp PR, models are NOT prefixed (`[pi]`/`[omp]`). Both directories share the same `pi` source label and the same pricing lookup.

### Metric mapping

| pi `message.usage` field | Mapped to                     |
| ------------------------ | ----------------------------- |
| `input`                  | `input_tokens`                |
| `output`                 | `output_tokens`               |
| `cacheRead`              | `cache_read_input_tokens`     |
| `cacheWrite`             | `cache_creation_input_tokens` |
| `totalTokens`            | surplus fallback (see above)  |

### Record filtering

A JSONL line is accepted as a billable message when:

- `type` is absent or `"message"` (event/tool lines are skipped)
- `message.role === "assistant"` (user messages are skipped)
- `message.usage` is present

Zero-token messages and messages without a model are skipped (the latter cannot be priced without guessing).

## Supported Models

Any model named in a pi/omp session is priced via the shared pricing database (LiteLLM). Models absent from the pricing dataset are reported with `$0.00` in `calculate` mode.

## Related

- [Daily Reports](/guide/daily-reports.md)
- [Monthly Reports](/guide/monthly-reports.md)
- [Session Reports](/guide/session-reports.md)
- [Cost Modes](/guide/cost-modes.md)
- [Environment Variables](/guide/environment-variables.md)
