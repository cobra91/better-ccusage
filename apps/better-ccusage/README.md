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

<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/cobra91/better-ccusage@main/docs/public/screenshot.png">
</div>

> Analyze your Claude Code or Droid token usage and costs from local JSONL files with multi-provider support — incredibly fast and informative!

## About better-ccusage

**better-ccusage** is a fork of the original ccusage project that addresses a critical limitation: while ccusage focuses exclusively on Claude Code usage with Anthropic models, better-ccusage extends support to external providers that use Claude Code with different providers like Anthropic, Zai, Dashscope and many models like glm series from Zai, kat-coder from Kwaipilot, kimi from Moonshot, Minimax, sonnet-4, sonnet-4.5 and Qwen-Max etc..

### Why the Fork?

The original ccusage project is designed specifically for Anthropic's Claude Code and doesn't account for:

- **Zai** providers that use Claude Code infrastructure with their own models
- **All GLM models (including GLM-5-Turbo), kat-coder, minimax, moonshot** models from other AI providers
- Multi-provider environments where organizations use different AI services through Claude Code

better-ccusage maintains full compatibility with ccusage while adding comprehensive support for these additional providers and models.

## better-ccusage Family

### 📊 [better-ccusage](https://www.npmjs.com/package/better-ccusage) - Enhanced Claude Code/Droid Usage Analyzer with Multi-Provider Support

The main CLI tool for analyzing Claude Code/Droid Usage from local JSONL files with support for multiple AI providers including Anthropic, Zai, and All GLM models (including GLM-5-Turbo), kat-coder models. Track daily, monthly, and session-based usage with beautiful tables and live monitoring.

### 🤖 [@better-ccusage/codex](https://www.npmjs.com/package/@better-ccusage/codex) - OpenAI Codex Usage Analyzer

Companion tool for analyzing OpenAI Codex usage. Same powerful features as better-ccusage but tailored for Codex users, including GPT-5 support and 1M token context windows.

### 🔌 [@better-ccusage/mcp](https://www.npmjs.com/package/@better-ccusage/mcp) - MCP Server Integration

Model Context Protocol server that exposes better-ccusage data to Claude Desktop and other MCP-compatible tools. Enable real-time usage tracking directly in your AI workflows.

## Installation

### Quick Start (Recommended)

Thanks to better-ccusage's incredibly small bundle size, you can run it directly without installation:

```bash
# Recommended - always include @latest to ensure you get the newest version
npx better-ccusage@latest
bunx better-ccusage

# Alternative package runners
pnpm dlx better-ccusage
pnpx better-ccusage

# Using deno (with security flags)
deno run -E -R=$HOME/.claude/projects/ -S=homedir -N='raw.githubusercontent.com:443' npm:better-ccusage@latest
```

> 💡 **Important**: We strongly recommend using `@latest` suffix with npx (e.g., `npx better-ccusage@latest`) to ensure you're running the most recent version with the latest features and bug fixes.

### Related Tools

#### Codex CLI

Analyze OpenAI Codex usage with our companion tool [@better-ccusage/codex](https://www.npmjs.com/package/@better-ccusage/codex):

```bash
# Recommended - always include @latest
npx @better-ccusage/codex@latest
bunx @better-ccusage/codex@latest  # ⚠️ MUST include @latest with bunx

# Alternative package runners
pnpm dlx @better-ccusage/codex
pnpx @better-ccusage/codex

# Using deno (with security flags)
deno run -E -R=$HOME/.codex/ -S=homedir -N='raw.githubusercontent.com:443' npm:@better-ccusage/codex@latest
```

> ⚠️ **Critical for bunx users**: Bun 1.2.x's bunx prioritizes binaries matching the package name suffix when given a scoped package. For `@better-ccusage/codex`, it looks for a `codex` binary in PATH first. If you have an existing `codex` command installed (e.g., GitHub Copilot's codex), that will be executed instead. **Always use `bunx @better-ccusage/codex@latest` with the version tag** to force bunx to fetch and run the correct package.

#### MCP Server

Integrate better-ccusage with Claude Desktop using [@better-ccusage/mcp](https://www.npmjs.com/package/@better-ccusage/mcp):

```bash
# Start MCP server for Claude Desktop integration
npx @better-ccusage/mcp@latest --type http --port 8080
```

This enables real-time usage tracking and analysis directly within Claude Desktop conversations.

## Usage

```bash
# Basic usage
npx better-ccusage          # Show daily report (default)
npx better-ccusage daily    # Daily token usage and costs
npx better-ccusage monthly  # Monthly aggregated report
npx better-ccusage session  # Usage by conversation session
npx better-ccusage blocks   # 5-hour billing windows
npx better-ccusage statusline  # Compact status line for hooks (Beta)

# Live monitoring
npx better-ccusage blocks --live  # Real-time usage dashboard

# Filters and options
npx better-ccusage daily --since 20250525 --until 20250530
npx better-ccusage daily --json  # JSON output
npx better-ccusage daily --breakdown  # Per-model cost breakdown
npx better-ccusage daily --timezone UTC  # Use UTC timezone
npx better-ccusage daily --locale ja-JP  # Use Japanese locale for date/time formatting

# Project analysis
npx better-ccusage daily --instances  # Group by project/instance
npx better-ccusage daily --project myproject  # Filter to specific project
npx better-ccusage daily --instances --project myproject --json  # Combined usage

# Compact mode for screenshots/sharing
npx better-ccusage --compact  # Force compact table mode
npx better-ccusage monthly --compact  # Compact monthly report
```

## Multi-Provider Support

better-ccusage extends the original ccusage functionality with automatic support for multiple AI providers:

### 🔄 Automatic Provider Detection

- **Zero Configuration Required**: New providers work automatically without code changes
- **Intelligent Model Resolution**: Finds models with or without provider prefixes
- **Fallback Matching**: Three-tier matching (exact → suffix → fuzzy) ensures models are always found

**How It Works**:

- Direct match: `"kimi-for-coding"` ✓
- Provider prefix match: `"moonshot/kimi-for-coding"` ✓
- Automatic fallback prevents `$0.00` costs from unfound models

### 🚀 Supported AI Providers & Models

**Moonshot AI** (kimi-* models):

- `kimi-k2-0905-preview`, `kimi-k2-0711-preview`, `kimi-k2-turbo-preview`
- `kimi-k2-thinking`, `kimi-k2-thinking-turbo`, `kimi-for-coding`

**MiniMax**:

- `MiniMax-M2`

**All GLM Models**

**Anthropic** (Claude models):

- All Claude models including `claude-sonnet-4-20250514`, `claude-sonnet-4-5-20250929`, etc.

**Zai Provider**:

- All Zai-specific model variants like glm-5

**And More**:

- kat-coder, deepseek, dashscope, streamlake, etc.

### 🌐 Provider-Aware Analytics

- Automatic provider detection from usage data
- Separate reporting and aggregation by provider
- Unified interface for multi-provider environments
- Accurate cost calculation for each provider's pricing structure

## Features

- 📊 **Daily Report**: View token usage and costs aggregated by date
- 📅 **Monthly Report**: View token usage and costs aggregated by month
- 💬 **Session Report**: View usage grouped by conversation sessions
- ⏰ **5-Hour Blocks Report**: Track usage within Claude's billing windows with active block monitoring
- 📈 **Live Monitoring**: Real-time dashboard showing active session progress, token burn rate, and cost projections with `blocks --live`
- 🚀 **Statusline Integration**: Compact usage display for Claude Code status bar hooks (Beta)
- 🤖 **Multi-Provider Model Tracking**: Track models from Anthropic, Zai, Dashscope and other providers
- 📊 **Model Breakdown**: View per-model cost breakdown with `--breakdown` flag
- 📅 **Date Filtering**: Filter reports by date range using `--since` and `--until`
- 📁 **Custom Path**: Support for custom Claude data directory locations
- 🎨 **Beautiful Output**: Colorful table-formatted display with automatic responsive layout
- 📱 **Smart Tables**: Automatic compact mode for narrow terminals (< 100 characters) with essential columns
- 📸 **Compact Mode**: Use `--compact` flag to force compact table layout, perfect for screenshots and sharing
- 📋 **Enhanced Model Display**: Model names shown as bulleted lists for better readability
- 📄 **JSON Output**: Export data in structured JSON format with `--json`
- 💰 **Cost Tracking**: Shows costs in USD for each day/month/session
- 🔄 **Cache Token Support**: Tracks and displays cache creation and cache read tokens separately
- 🔌 **MCP Integration**: Built-in Model Context Protocol server for integration with other tools
- 🏗️ **Multi-Instance Support**: Group usage by project with `--instances` flag and filter by specific projects
- 🌍 **Timezone Support**: Configure timezone for date grouping with `--timezone` option
- 🌐 **Locale Support**: Customize date/time formatting with `--locale` option (e.g., en-US, ja-JP, de-DE)
- ⚙️ **Configuration Files**: Set defaults with JSON configuration files, complete with IDE autocomplete and validation
- 🚀 **Ultra-Small Bundle**: Unlike other CLI tools, we pay extreme attention to bundle size - incredibly small even without minification!

## Comparison with ccusage

| Feature                      | ccusage | better-ccusage |
| ---------------------------- | ------- | -------------- |
| Anthropic Models             | ✅      | ✅             |
| Moonshot (kimi) Models       | ❌      | ✅             |
| MiniMax Models               | ❌      | ✅             |
| GLM* Models                  | ❌      | ✅             |
| Zai Provider                 | ❌      | ✅             |
| kat-coder                    | ❌      | ✅             |
| **Automatic Provider Detection** | ❌  | ✅             |
| Multi-Provider Support       | ❌      | ✅             |
| Cost Calculation by Provider | ❌      | ✅             |
| Original ccusage Features    | ✅      | ✅             |
| Show prompt usage for Coding | ❌      | ✅             |
| Droid usage                  | ❌      | ✅             |

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
