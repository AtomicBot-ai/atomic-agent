# MCP client and tool catalog

Status: current
Owner: src/mcp/

This area owns mcp client and tool catalog. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [mcp-client.ts](mcp-client.ts)
- [mcp-manager.ts](mcp-manager.ts)
- [mcp-resource-class.ts](mcp-resource-class.ts)
- [mcp-sampling-handler.ts](mcp-sampling-handler.ts)
- [mcp-catalog.ts](mcp-catalog.ts) and [mcp-catalog-data.ts](mcp-catalog-data.ts): the built-in server catalog the add flows pick from

## Ownership and dependencies

McpManager owns configured connections, discovery catalogs and dynamic tool registration; McpClient owns SDK transports and sampling integration. Resource classification maps server trust into dispatch policy. [TUI MCP feature](../tui/mcp/README.md) renders manager state and calls [shared config commands](../config/mcp-server-commands.ts); runtime owns the manager lifetime. Stdio processes get only allowlisted service variables plus their configured `env`; see docs/client.md.

Cloud tool, resource and prompt text projections bypass presentation character caps. Tool responses retain structured content plus additional text and embedded resource text, suppressing only an exact JSON mirror. Binary blocks keep their existing textual markers. Local projection precedence and caps are unchanged; trust and approval gates apply in either mode. [Adapter tests](mcp-tool-adapter.test.ts) cover both projections.

## Server catalog

[mcp-catalog-data.ts](mcp-catalog-data.ts) lists known servers by shelf (Basics, Code & docs, Work apps, Web & growth). An entry is only a pasteable `mcpServers` shortcut plus the `<your ...>` values the user must fill in, each with a label and, for keys, where to get one. Picking an entry fills the add box; the normal `parseAddServerJson` + `persistMcpServer` path still does the write, and a submit that still holds a placeholder is refused. Add an entry only after checking its package name or URL and key variable against the official README; OAuth-only servers stay out until `mcp.servers` can sign in. The desktop keeps a copy in `desktop/renderer/mcp-catalog.js` on the desktop branch, and its test compares the two.

## Task-specific reading

Read docs/client.md before lifecycle, trust, sampling or dynamic schema changes; ../tui/AGENTS.md for MCP panel work.

## Validation

`npx vitest run src/mcp`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).

Approval: tools from an `approval_gated` server ask before every call. A tool's own `readOnlyHint: true` skips the prompt only on a stdio server the operator installed on this machine, and on a remote server only for tools the agent's own integrations name in `trustedReadOnlyTools` (today Composio's two discovery tools; this field is not read from `config.json`). Other remote HTTP / SSE tools ask like everything else, whatever they say about themselves (ATO-1178). stdio is not a promise that nothing leaves the machine: a stdio wrapper around a cloud API sends its arguments out too. "Allow in this chat" on the prompt silences MCP tool prompts for the rest of the session.
