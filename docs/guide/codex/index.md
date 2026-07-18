# Codex Source

![Codex CLI daily report](/codex-cli.jpeg)

OpenAI Codex CLI sessions are now a **built-in source** in `better-ccusage`, read automatically alongside Claude, Droid, and ZCode data. The standalone `@better-ccusage/codex` package has been deprecated and now forwards to `better-ccusage`.

## Quick Start

```bash
# Codex usage now appears in every report automatically
npx better-ccusage daily
npx better-ccusage monthly
npx better-ccusage session
```

Codex rows are labeled with the `codex` source in combined reports. You get the same Daily / Weekly / Monthly / Session / Blocks commands as for every other source.

## Backward compatibility

The `@better-ccusage/codex` package still works as a thin forwarder:

```bash
# Still works — forwarded transparently to better-ccusage
npx @better-ccusage/codex daily --json
```

A one-line deprecation notice is printed to stderr. Set `CODEX_NO_DEPRECATION_NOTICE=1` to silence it (useful in CI).

## Data Source

`better-ccusage` reads Codex session JSONL files located under `CODEX_HOME` (defaults to `~/.codex/sessions`). Each file represents a single Codex CLI session and contains running token totals that are converted into per-event deltas.

## What Gets Calculated

- **Token deltas** – Each `event_msg` with `payload.type === "token_count"` reports cumulative totals. The adapter subtracts the previous totals to recover per-turn token usage (input, cached input, output).
- **Per-model grouping** – The `turn_context` metadata specifies the active model. Tokens are aggregated per day/month and per model.
- **Unified cost model** – Codex tokens now use the same additive cost engine as Claude: `input` is billed at the input price, `cache_read` at the cache-read discount, and `output` (which already includes reasoning) at the output price. Reasoning tokens are tracked internally but not billed separately.
- **Pricing aliases** – `gpt-5-codex` is aliased to `gpt-5` so the shared pricing fetcher resolves it correctly.
- **Legacy fallback** – Logs that never recorded model metadata are priced as `gpt-5` so usage still appears in reports.

## Environment Variables

| Variable     | Description                                                  |
| ------------ | ------------------------------------------------------------ |
| `CODEX_HOME` | Override the root directory containing Codex session folders |
| `OFFLINE`    | Skip the remote pricing fetch and use the bundled dataset    |

## Why the merge?

Maintaining a separate Codex CLI duplicated ~2,000 lines that `better-ccusage` already offered. The upstream [`ccusage`](https://github.com/ryoppippi/ccusage) project had already consolidated Codex as a built-in source, and this merge aligns with that architecture. The standalone package was reduced to a ~150-line forwarder that preserves existing aliases and CI scripts.

## Troubleshooting

::: details Why are there no entries before September 2025?
OpenAI's Codex CLI started emitting `token_count` events in September 2025. Earlier session logs don't contain token usage metrics, so there is nothing to aggregate.
:::
