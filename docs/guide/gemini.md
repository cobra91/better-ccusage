# Gemini CLI Source

better-ccusage reads [Gemini CLI](https://github.com/google-gemini/gemini-cli) usage directly from its local log directory — no API keys required. (Model pricing may still be fetched from LiteLLM once per 24h unless a cached copy exists; see the environment variables guide to disable it.)

## Usage

```bash
# All sources (Gemini CLI auto-detected)
better-ccusage daily

# Gemini CLI only
better-ccusage gemini daily
```

## Data Location

By default, better-ccusage scans `~/.gemini/tmp/` recursively for JSON and JSONL log files:

- **Chat session documents** (`chats/session-*.json`): whole-file JSON with a `messages` array; each `type: "gemini"` message carries a `tokens` block.
- **JSONL logs**: per-line records — session envelopes update the session id/model, `type: "gemini"` lines are per-message usage events (deduplicated by message id), and `stats` lines carry aggregated counters (flat or per-model).

## Token semantics

Gemini CLI token counters use many key aliases (`input`/`prompt`/`input_tokens`, `output`/`candidates`, `cached`/`cached_tokens`, `thoughts`/`reasoning`, `tool`/`tool_tokens`). better-ccusage normalizes them like upstream ccusage:

- **Session events**: when `total` equals the sum *without* `cached`, the `input` counter includes the cached share — the cached tokens are split into the cache-read bucket (billed at the cache rate) and only the fresh remainder is billed at the input rate.
- **Stats blocks**: the `input` counter always includes the cached share; the overlap is subtracted.
- **Tool tokens** are billed as input; **thoughts/reasoning tokens** are billed at the output rate.

## Environment Variable

```bash
GEMINI_DATA_DIR=/path/to/gemini/tmp better-ccusage daily
```

`GEMINI_DATA_DIR` accepts a comma-separated list of directories. When set, only the listed directories are scanned (the default `~/.gemini/tmp` is skipped).
