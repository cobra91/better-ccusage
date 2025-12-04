<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/cobra91/better-ccusage@main/docs/public/logo.svg" alt="better-ccusage logo" width="256" height="256">
    <h1>@better-ccusage/mcp</h1>
</div>

<p align="center">
    <a href="https://socket.dev/api/npm/package/@better-ccusage/mcp"><img src="https://socket.dev/api/badge/npm/package/@better-ccusage/mcp" alt="Socket Badge" /></a>
    <a href="https://npmjs.com/package/@better-ccusage/mcp"><img src="https://img.shields.io/npm/v/@better-ccusage/mcp?color=yellow" alt="npm version" /></a>
    <a href="https://tanstack.com/stats/npm?packageGroups=%5B%7B%22packages%22:%5B%7B%22name%22:%22@better-ccusage/mcp%22%7D%5D%7D%5D&range=30-days&transform=none&binType=daily&showDataMode=all&height=400"><img src="https://img.shields.io/npm/dy/@better-ccusage/mcp" alt="NPM Downloads" /></a>
    <a href="https://packagephobia.com/result?p=@better-ccusage/mcp"><img src="https://packagephobia.com/badge?p=@better-ccusage/mcp" alt="install size" /></a>
    <a href="https://deepwiki.com/cobra91/better-ccusage"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
</p>

<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/cobra91/better-ccusage@main/docs/public/mcp-claude-desktop.avif" alt="Claude Desktop MCP integration screenshot" width="640">
</div>

> MCP (Model Context Protocol) server implementation for better-ccusage - provides Claude Code/Droid Usage data through the MCP protocol.

## Quick Start

```bash
# Using bunx (recommended for speed)
bunx @better-ccusage/mcp@latest

# Using npx
npx @better-ccusage/mcp@latest

# Start with HTTP transport
bunx @better-ccusage/mcp@latest -- --type http --port 8080
```

## Integrations

### Claude Desktop Integration

Add to your Claude Desktop MCP configuration:

```json
{
	"mcpServers": {
		"better-ccusage": {
			"command": "npx",
			"args": ["@better-ccusage/mcp@latest"],
			"type": "stdio"
		}
	}
}
```

### Claude Code

```sh
claude mcp add better-ccusage npx -- @better-ccusage/mcp@latest
```

## Documentation

For full documentation, visit **[better-ccusage.com/guide/mcp-server](https://better-ccusage.com/guide/mcp-server)**

## Sponsors

### Featured Sponsor

<p align="center">
    <a href="https://github.com/sponsors/cobra91">
        Cobra91
    </a>
</p>

## License

MIT © [@cobra91](https://github.com/cobra91)
