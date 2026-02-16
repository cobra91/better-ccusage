<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/cobra91/better-ccusage@main/docs/public/logo.svg" alt="better-ccusage logo" width="256" height="256">
    <h1>better-ccusage</h1>
</div>

<p align="center">
    <a href="https://npmjs.com/package/better-ccusage"><img src="https://img.shields.io/npm/v/better-ccusage?color=yellow" alt="npm version" /></a>
    <a href="https://packagephobia.com/result?p=better-ccusage"><img src="https://packagephobia.com/badge?p=better-ccusage" alt="install size" /></a>
    <a href="https://zread.ai/cobra91/better-ccusage" target="_blank"><img src="https://img.shields.io/badge/Ask_Zread-_.svg?style=flat&color=00b0aa&labelColor=000000&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQuOTYxNTYgMS42MDAxSDIuMjQxNTZDMS44ODgxIDEuNjAwMSAxLjYwMTU2IDEuODg2NjQgMS42MDE1NiAyLjI0MDFWNC45NjAxQzEuNjAxNTYgNS4zMTM1NiAxLjg4ODEgNS42MDAxIDIuMjQxNTYgNS42MDAxSDQuOTYxNTZDNS4zMTUwMiA1LjYwMDEgNS42MDE1NiA1LjMxMzU2IDUuNjAxNTYgNC45NjAxVjIuMjQwMUM1LjYwMTU2IDEuODg2NjQgNS4zMTUwMiAxLjYwMDEgNC45NjE1NiAxLjYwMDFaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00Ljk2MTU2IDEwLjM5OTlIMi4yNDE1NkMxLjg4ODEgMTAuMzk5OSAxLjYwMTU2IDEwLjY4NjQgMS42MDE1NiAxMS4wMzk5VjEzLjc1OTlDMS42MDE1NiAxNC4xMTM0IDEuODg4MSAxNC4zOTk5IDIuMjQxNTYgMTQuMzk5OUg0Ljk2MTU2QzUuMzE1MDIgMTQuMzk5OSA1LjYwMTU2IDE0LjExMzQgNS42MDE1NiAxMy43NTk5VjExLjAzOTlDNS42MDE1NiAxMC42ODY0IDUuMzE1MDIgMTAuMzk5OSA0Ljk2MTU2IDEwLjM5OTlaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik0xMy43NTg0IDEuNjAwMUgxMS4wMzg0QzEwLjY4NSAxLjYwMDEgMTAuMzk4NCAxLjg4NjY0IDEwLjM5ODQgMi4yNDAxVjQuOTYwMUMxMC4zOTg0IDUuMzEzNTYgMTAuNjg1IDUuNjAwMSAxMS4wMzg0IDUuNjAwMUgxMy43NTg0QzE0LjExMTkgNS42MDAxIDE0LjM5ODQgNS4zMTM1NiAxNC4zOTg0IDQuOTYwMVYyLjI0MDFDMTQuMzk4NCAxLjg4NjY0IDE0LjExMTkgMS42MDAxIDEzLjc1ODQgMS42MDAxWiIgZmlsbD0iI2ZmZiIvPgo8cGF0aCBkPSJNNCAxMkwxMiA0TDQgMTJaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00IDEyTDEyIDQiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K&logoColor=ffffff" alt="zread"/></a>
    <a href="https://deepwiki.com/cobra91/better-ccusage"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
    <a href="https://claudelog.com/"><img src="https://claudelog.com/img/claude_log_badge.svg" alt="ClaudeLog - A comprehensive knowledge base for Claude." /></a>
    <img alt="CodeRabbit Pull Request Reviews" src="https://img.shields.io/coderabbit/prs/github/cobra91/better-ccusage">
</p>

> Analyze [OpenCode](https://github.com/opencode-ai/opencode) usage logs with the same reporting experience as <code>better-ccusage</code>.

## Quick Start

```bash
# Recommended - always include @latest
npx @better-ccusage/opencode@latest --help
bunx @better-ccusage/opencode@latest --help

# Alternative package runners
pnpm dlx @better-ccusage/opencode
pnpx @better-ccusage/opencode

# Using deno (with security flags)
deno run -E -R=$HOME/.local/share/opencode/ -S=homedir -N='raw.githubusercontent.com:443' npm:@better-ccusage/opencode@latest --help
```

### Recommended: Shell Alias

Since `npx @better-ccusage/opencode@latest` is quite long to type repeatedly, we strongly recommend setting up a shell alias:

```bash
# bash/zsh: alias better-ccusage-opencode='bunx @better-ccusage/opencode@latest'
# fish:     alias better-ccusage-opencode 'bunx @better-ccusage/opencode@latest'

# Then simply run:
better-ccusage-opencode daily
better-ccusage-opencode monthly --json
```

> 💡 The CLI looks for OpenCode usage data under `OPENCODE_DATA_DIR` (defaults to `~/.local/share/opencode`).

## Common Commands

```bash
# Daily usage grouped by date (default command)
npx @better-ccusage/opencode@latest daily

# Weekly usage grouped by ISO week
npx @better-ccusage/opencode@latest weekly

# Monthly usage grouped by month
npx @better-ccusage/opencode@latest monthly

# Session-level detailed report
npx @better-ccusage/opencode@latest session

# JSON output for scripting
npx @better-ccusage/opencode@latest daily --json

# Compact mode for screenshots/sharing
npx @better-ccusage/opencode@latest daily --compact
```

Useful environment variables:

- `OPENCODE_DATA_DIR` – override the OpenCode data directory (defaults to `~/.local/share/opencode`)
- `LOG_LEVEL` – control consola log verbosity (0 silent … 5 trace)

## Features

- 📊 **Daily Reports**: View token usage and costs aggregated by date
- 📅 **Weekly Reports**: View usage grouped by ISO week (YYYY-Www)
- 🗓️ **Monthly Reports**: View usage aggregated by month (YYYY-MM)
- 💬 **Session Reports**: View usage grouped by conversation sessions
- 📈 **Responsive Tables**: Automatic layout adjustment for terminal width
- 🤖 **Model Tracking**: See which Claude models you're using (Opus, Sonnet, Haiku, etc.)
- 💵 **Accurate Cost Calculation**: Uses LiteLLM pricing database to calculate costs from token data
- 🔄 **Cache Token Support**: Tracks and displays cache creation and cache read tokens separately
- 📄 **JSON Output**: Export data in structured JSON format with `--json`
- 📱 **Compact Mode**: Use `--compact` flag for narrow terminals, perfect for screenshots

## Cost Calculation

OpenCode stores `cost: 0` in message files, so this CLI calculates accurate costs from token usage data using the LiteLLM pricing database. All models supported by LiteLLM will have accurate pricing.

## Data Location

OpenCode stores usage data in:

- **Messages**: `~/.local/share/opencode/storage/message/{sessionID}/msg_{messageID}.json`
- **Sessions**: `~/.local/share/opencode/storage/session/{projectHash}/{sessionID}.json`

Each message file contains token counts (`input`, `output`, `cache.read`, `cache.write`) and model information.

## Sponsors

### Featured Sponsor

<p align="center">
    <a href="https://github.com/sponsors/cobra91">
        <img src="https://cdn.jsdelivr.net/gh/cobra91/sponsors@main/sponsors.svg">
    </a>
</p>

## Star History

<a href="https://www.star-history.com/#cobra91/better-ccusage&Date">
    <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=cobra91/better-ccusage&type=Date&theme=dark" />
        <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=cobra91/better-ccusage&type=Date" />
        <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=cobra91/better-ccusage&type=Date" />
    </picture>
</a>

## License

[MIT](LICENSE) © [@cobra91](https://github.com/cobra91)
