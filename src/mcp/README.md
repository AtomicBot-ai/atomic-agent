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

McpManager owns configured connections, discovery catalogs and dynamic tool registration; McpClient owns SDK transports and sampling integration. Resource classification maps server trust into dispatch policy. [TUI MCP feature](../tui/mcp/README.md) renders manager state and calls [shared config commands](../config/mcp-server-commands.ts); runtime owns the manager lifetime. Stdio processes get only allowlisted service variables plus their configured `env`; see docs/client.md.

Cloud tool, resource and prompt text projections bypass presentation character caps. Tool responses retain structured content plus additional text and embedded resource text, suppressing only an exact JSON mirror. Binary blocks keep their existing textual markers. Local projection precedence and caps are unchanged; trust and approval gates apply in either mode. [Adapter tests](mcp-tool-adapter.test.ts) cover both projections.

## Task-specific reading

Read docs/client.md before lifecycle, trust, sampling or dynamic schema changes; ../tui/AGENTS.md for MCP panel work.

## Validation

`npx vitest run src/mcp`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).

Approval: tools from an `approval_gated` server ask before every call. A tool's own `readOnlyHint: true` skips the prompt only on a stdio server the operator installed on this machine, and on a remote server only for tools the agent's own integrations name in `trustedReadOnlyTools` (today Composio's two discovery tools; this field is not read from `config.json`). Other remote HTTP / SSE tools ask like everything else, whatever they say about themselves (ATO-1178). stdio is not a promise that nothing leaves the machine: a stdio wrapper around a cloud API sends its arguments out too. "Allow in this chat" on the prompt silences MCP tool prompts for the rest of the session.

Per-server approval mode (ATO-1134): `mcp.servers[].approval` in `config.json` replaces the answer above for that server's tools ([mcp-approval-mode.ts](mcp-approval-mode.ts)). `ask`: the default `approval_gated` behaviour, also on a `pure_read` server. `ask_writes`: a tool whose discovery-time `readOnlyHint` is `true` runs unasked only on a stdio server; every other tool asks, and so does every tool of a remote HTTP / SSE server, including the agent's own `trustedReadOnlyTools` exceptions (ATO-1178). `auto`: no prompt. Absent: `trust` decides, as before. `trust` still decides batching. A call a mode lets through that the default would have asked about still goes to the gate when a saved deny or ask rule names it (`savedRuleOverridesScope`).
