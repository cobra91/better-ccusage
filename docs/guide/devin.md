# Devin Usage Tracking

better-ccusage provides usage tracking for [Devin](https://devin.ai) (Cognition), reading the ATIF trajectory transcripts that the Devin CLI writes locally. This lets you monitor token usage and costs across your Devin sessions alongside Claude Code, Droid, ZCode, Codex, and OpenCode — all in one report.

Devin support is **built into `better-ccusage`** — there is no separate package to install.

## Usage

Devin usage is included automatically in every report. Run any standard command and Devin data (when present) appears alongside the other sources:

```bash
# Daily report (all sources, including Devin)
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

The `Source` column in the output shows `devin` for entries parsed from Devin transcripts.

## Data Location

The Devin CLI writes its data under a platform-specific directory:

- **Linux/macOS**: `~/.local/share/devin/cli/`
- **Windows**: `%APPDATA%\devin\cli\`

Within that directory, better-ccusage reads:

| Path                 | Description                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `transcripts/*.json` | ATIF trajectory transcripts (one JSON document per file, recursive)                                                             |
| `sessions.db`        | Optional SQLite DB enriching transcripts with the working directory, a model fallback, timestamps, and hidden-session filtering |

### Custom Data Directory

Override the data directory with the `DEVIN_DATA_DIR` environment variable:

```bash
export DEVIN_DATA_DIR=/custom/path/to/devin/cli
npx better-ccusage daily
```

## Token & Cost Semantics

- **Additive token model**: the four buckets (input/prompt, output/completion, cache-read/cached, cache-creation) are independent and summed. Cached tokens are **not** subtracted from input (unlike Codex, where `input_tokens` include the cached portion). This matches the Claude cost model.
- **Cost**: ATIF v1.7 records a per-step `committed_credit_cost` (USD). The default `auto` cost mode uses it directly; `calculate` mode recomputes from tokens via the shared pricing engine.
- **Hidden sessions**: sessions flagged `hidden = 1` in `sessions.db` are skipped entirely (their transcripts are not processed, even if the transcript carries its own model).

### Metric sources

Per-step metrics are read from `step.metrics` (ATIF v1.7):

| ATIF field                                  | Mapped to                     |
| ------------------------------------------- | ----------------------------- |
| `metrics.prompt_tokens`                     | `input_tokens`                |
| `metrics.completion_tokens`                 | `output_tokens`               |
| `metrics.cached_tokens`                     | `cache_read_input_tokens`     |
| `metrics.extra.cache_creation_input_tokens` | `cache_creation_input_tokens` |

When `step.metrics` is absent, the adapter falls back to the legacy `step.metadata.metrics` schema (`input_tokens`, `output_tokens`, `cache_creation_tokens`, `cache_read_tokens`).

## Supported Models

Any model named in a Devin transcript is priced via the shared pricing database (LiteLLM). Models common in Devin sessions (e.g. `sonnet-4-6`, `kimi-k2-7`, `MODEL_SWE_1_5`) are resolved automatically. Models absent from the pricing dataset are reported with `$0.00` in `calculate` mode.

## Related

- [Daily Reports](/guide/daily-reports.md)
- [Monthly Reports](/guide/monthly-reports.md)
- [Session Reports](/guide/session-reports.md)
- [Cost Modes](/guide/cost-modes.md)
- [Environment Variables](/guide/environment-variables.md)
