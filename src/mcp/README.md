# MCP client and tool catalog

Status: current
Owner: src/mcp/

This area owns mcp client and tool catalog. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [mcp-client.ts](mcp-client.ts)
- [mcp-manager.ts](mcp-manager.ts)
- [mcp-resource-class.ts](mcp-resource-class.ts)
- [mcp-sampling-handler.ts](mcp-sampling-handler.ts)

## Ownership and dependencies

McpManager owns configured connections, discovery catalogs and dynamic tool registration; McpClient owns SDK transports and sampling integration. Resource classification maps server trust into dispatch policy. [TUI MCP feature](../tui/mcp/README.md) renders manager state and calls [shared config commands](../config/mcp-server-commands.ts); runtime owns the manager lifetime. Stdio processes currently inherit the agent environment; see docs/client.md.

## Task-specific reading

Read docs/client.md before lifecycle, trust, sampling or dynamic schema changes; ../tui/AGENTS.md for MCP panel work.

## Validation

`npx vitest run src/mcp`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
