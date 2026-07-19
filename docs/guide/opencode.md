# OpenCode Usage Tracking

`better-ccusage` reads [OpenCode](https://github.com/sst/opencode) usage directly from its SQLite database and aggregates it alongside Claude, Droid, ZCode, Codex, and Devin data — no separate package required.

> ⚠️ The standalone `@better-ccusage/opencode` package is **deprecated** and only forwards invocations to `better-ccusage`. Run `better-ccusage` directly.

## Where the data comes from

OpenCode stores per-message token usage in a SQLite database. `better-ccusage` reads it (read-only) from:

- Default: `~/.local/share/opencode/opencode.db`
- Override with the `OPENCODE_DATA_DIR` environment variable (points at the directory that contains `opencode.db`).

Each assistant message with a non-zero token count becomes one usage entry. `tokens.input` already excludes cached tokens, so the Claude additive cost model applies directly; OpenCode's reasoning-token surplus is folded into `output_tokens` (matching upstream `ccusage`).

## Usage

By default every report aggregates all detected sources. To see OpenCode usage only, use the `<source> <report>` syntax:

```bash
# OpenCode-only daily report
npx better-ccusage opencode daily

# OpenCode-only billing blocks
npx better-ccusage opencode blocks

# OpenCode-only session report
npx better-ccusage opencode session

# Shorthand: 'opencode' alone defaults to 'opencode daily'
npx better-ccusage opencode
```

The equivalent explicit form also works (`npx better-ccusage daily --source opencode`), but the positional form above is preferred. See the [Command-Line Options](/guide/cli-options.md) page for the full flag list.

## Troubleshooting

If OpenCode data is missing from your reports, `better-ccusage` now warns when:

- The OpenCode database is not found at the expected path — check `OPENCODE_DATA_DIR` or the default `~/.local/share/opencode/opencode.db`.
- The database exists and has message rows, but none yielded usage entries — messages without token usage, with all-zero tokens, or without a model id are skipped.

## Related

- [Daily Reports](/guide/daily-reports.md)
- [Session Reports](/guide/session-reports.md)
- [Blocks Reports](/guide/blocks-reports.md)
- [Environment Variables](/guide/environment-variables.md)
