# Introduction

![better-ccusage daily report showing token usage and costs by date](/screenshot.png)

**better-ccusage** (better-claude-code-usage) is a powerful CLI tool that analyzes your Claude Code/Droid Usage from local JSONL files to help you understand your token consumption patterns and estimated costs with multi-provider support.

## The Problem

Claude Code's Max plan offers unlimited usage, which is fantastic! But many users are curious:

- How much am I actually using Claude Code?
- Which conversations are the most expensive?
- What would I be paying on a pay-per-use plan?
- Am I getting good value from my subscription?

## The Solution

better-ccusage analyzes the local JSONL files that Claude Code automatically generates and provides:

- **Detailed Usage Reports** - Daily, monthly, and session-based breakdowns
- **Cost Analysis** - Estimated costs based on token usage and model pricing
- **Live Monitoring** - Real-time tracking of active sessions
- **Multiple Formats** - Beautiful tables or JSON for further analysis

## How It Works

1. **Claude Code generates JSONL files** containing usage data
2. **better-ccusage reads these files** from your local machine
3. **Analyzes and aggregates** the data by date, session, or time blocks
4. **Calculates estimated costs** using model pricing information
5. **Presents results** in beautiful tables or JSON format

## Key Features

### 🚀 Ultra-Small Bundle Size

Unlike other CLI tools, we pay extreme attention to bundle size. better-ccusage achieves an incredibly small footprint even without minification, which means you can run it directly without installation using `bunx better-ccusage` for instant access.

### 📊 Multiple Report Types

- **Daily Reports** - Usage aggregated by calendar date
- **Weekly Reports** - Usage aggregated by week with configurable start day
- **Monthly Reports** - Monthly summaries with trends
- **Session Reports** - Per-conversation analysis
- **Blocks Reports** - 5-hour billing window tracking

### 💰 Cost Analysis

- Estimated costs based on token counts and model pricing
- Support for different cost calculation modes
- Model-specific pricing (Opus vs Sonnet vs other models)
- Cache token cost calculation

### 📈 Live Monitoring

- Real-time dashboard for active sessions
- Progress bars and burn rate calculations
- Token limit warnings and projections
- Automatic refresh with configurable intervals

### 🔧 Flexible Configuration

- **JSON Configuration Files** - Set defaults for all commands or customize per-command
- **IDE Support** - JSON Schema for autocomplete and validation
- **Priority-based Settings** - CLI args > local config > user config > defaults
- **Multiple Claude Data Directories** - Automatic detection and aggregation
- **Environment Variables** - Traditional configuration options
- **Custom Date Filtering** - Flexible time range selection and sorting
- **Offline Mode** - Cached pricing data for air-gapped environments

## Multi-Provider Support

better-ccusage extends the original ccusage functionality with support for multiple AI providers:

### 🔄 Zai Provider Integration

- Track usage when using Zai's Claude Code integration
- Support for Zai-specific model variants
- Accurate cost calculation for Zai pricing

### 🚀 GLM-4.5, GLM-4.6, GLM-4.7, kat-coder Model Support

- Full support for GLM-4.5, GLM-4.6, GLM-4.7, kat-coder models from various providers
- Token counting and cost calculation optimized for GLM-4.5, GLM-4.6, GLM-4.7, kat-coder (beta)
- Compatibility with existing Claude Code workflows

### 🌐 Provider Detection

- Automatic detection of provider from usage data
- Separate reporting and aggregation by provider
- Unified interface for multi-provider environments

### 🎯 Moonshot AI (kimi) Support

- Full support for kimi models (kimi-for-coding, kimi-researcher, etc.)
- Automatic model detection without manual configuration
- Support for both `"kimi-..."` and `"moonshot/kimi-..."` naming
- Estimated cost calculation for Moonshot AI pricing

### 🤖 MiniMax Model Support

- Support for MiniMax models like `MiniMax-M2`
- Automatic provider detection and model matching
- Token counting and cost calculation for MiniMax models
- Compatible with existing Claude Code workflows

## Why better-ccusage?

better-ccusage was created to address a limitation in the original ccusage project: while ccusage focuses exclusively on Claude Code usage with Anthropic models, better-ccusage extends support to external tools/providers that use Claude Code/Droid with different providers like Zai, Dashcope and many models like GLM-4.5, GLM-4.6, GLM-4.7, kat-coder, kimi, MiniMax etc.

The original ccusage project doesn't account for:

- **Zai** providers that use Claude Code infrastructure with their own models
- **GLM-4.5, GLM-4.6, GLM-4.7, kat-coder** models from other AI providers
- **Moonshot AI** (kimi) models like kimi-for-coding, kimi-researcher
- **MiniMax** models like MiniMax-M2
- Multi-provider environments where organizations use different AI services through Claude Code

better-ccusage maintains full compatibility with ccusage while adding comprehensive support for these additional providers and models.

## Data Sources

better-ccusage reads from Claude Code's local data directories:

- **New location**: `~/.config/claude/projects/` (Claude Code v1.0.30+)
- **Legacy location**: `~/.claude/projects/` (pre-v1.0.30)

The tool automatically detects and aggregates data from both locations for compatibility.

## Privacy & Security

- **100% Local** - All analysis happens on your machine
- **No Data Transmission** - Your usage data never leaves your computer
- **Read-Only** - better-ccusage only reads files, never modifies them
- **Open Source** - Full transparency in how your data is processed

## Limitations

::: warning Important Limitations

- **Local Files Only** - Only analyzes data from your current machine
- **Language Model Tokens** - API calls for tools like Web Search are not included
- **Estimate Accuracy** - Costs are estimates and may not reflect actual billing
  :::

## Getting Started

Ready to analyze your Claude Code/Droid Usage? Check out our [Getting Started Guide](/guide/getting-started) to begin exploring your data!
