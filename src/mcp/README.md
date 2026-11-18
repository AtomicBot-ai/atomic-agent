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
- [mcp-elicitation-handler.ts](mcp-elicitation-handler.ts)
- [mcp-oauth-flow.ts](mcp-oauth-flow.ts): browser sign-in for remote servers, see docs/client.md

## Ownership and dependencies

McpManager owns configured connections, discovery catalogs and dynamic tool registration; McpClient owns SDK transports and sampling and elicitation integration; elicitation reaches a person only through a host-wired port (docs/client.md). Resource classification maps server trust into dispatch policy. [TUI MCP feature](../tui/mcp/README.md) renders manager state and calls [shared config commands](../config/mcp-server-commands.ts); runtime owns the manager lifetime. Stdio processes get only allowlisted service variables plus their configured `env`; see docs/client.md.

Cloud tool, resource and prompt text projections bypass presentation character caps. Tool responses retain structured content plus additional text and embedded resource text, suppressing only an exact JSON mirror. Binary blocks keep their existing textual markers. Local projection precedence and caps are unchanged; trust and approval gates apply in either mode. [Adapter tests](mcp-tool-adapter.test.ts) cover both projections.

## Server catalog

[mcp-catalog-data.ts](mcp-catalog-data.ts) lists known servers by shelf (Basics, Code & docs, Work apps, Web & growth). An entry is only a pasteable `mcpServers` shortcut plus the `<your ...>` values the user must fill in, each with a label and, for keys, where to get one. Picking an entry fills the add box; the normal `parseAddServerJson` + `persistMcpServer` path still does the write, and a submit that still holds a placeholder is refused. Add an entry only after checking its package name or URL and key variable against the official README; A server that signs in through the browser instead of taking a key carries `"auth": "oauth"` (url servers only); the add flows then point at `/mcp auth <id>` or the desktop row's Sign in. The desktop keeps a copy in `desktop/renderer/mcp-catalog.js` on the desktop branch, and its test compares the two.

## MCP Apps

[mcp-apps.ts](mcp-apps.ts) (ATO-1135) is the core half of MCP Apps (the `io.modelcontextprotocol/ui` extension, SEP-1865). Discovery keeps a tool's `_meta.ui.resourceUri` (or the deprecated flat `_meta["ui/resourceUri"]`) as `McpToolMeta.ui`, and drops a tool whose `_meta.ui.visibility` leaves out `"model"`, as the spec requires. When the host sets `McpClientDeps.appsUi` (the runtime sets it when the process env has `ATOMIC_AGENT_MCP_APPS_UI=1`, which the desktop app passes to the agent it starts; `mcpAppsUiFromEnv`), after an ok call to a tool with a page, the adapter reads that `ui://` resource under its own 5 s deadline (`MCP_APP_FETCH_TIMEOUT_MS`, so a slow read never holds the result back) and, when it is `text/html;profile=mcp-app` and at most 4 MB, puts it on the result as `details.mcpApp` (`resourceUri`, `html`, the server's `csp` / `permissions` / `domain` / `prefersBorder` requests, plus `toolInput` and `toolResult` for the page). Any failure means no page, never a failed call. The model reads only the summary, so it never sees the page; the HTTP stream forwards it as `mcp_app` on the `tool_result` event, and the session file, the trace file, the TUI's tool cards and the loop detector's hashes leave it out (`withoutMcpAppPage`). Without `appsUi` the client neither advertises the extension in `initialize` nor reads any page. Rendering, the page's postMessage JSON-RPC and app-to-server calls belong to the client.

## Offline mode

While offline mode is on (ATO-1084), a `streamable_http` or `sse` server that is not on this machine is refused before connecting. A stdio server is a separate program and is not network-isolated. See [offline mode](../llm/docs/offline-network.md).

## Task-specific reading

Read docs/client.md before lifecycle, trust, sampling, elicitation or dynamic schema changes; ../tui/AGENTS.md for MCP panel work.

## Validation

`npx vitest run src/mcp`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).

Approval: tools from an `approval_gated` server ask before every call. A tool's own `readOnlyHint: true` skips the prompt only on a stdio server the operator installed on this machine, and on a remote server only for tools the agent's own integrations name in `trustedReadOnlyTools` (today Composio's two discovery tools; this field is not read from `config.json`). Other remote HTTP / SSE tools ask like everything else, whatever they say about themselves (ATO-1178). stdio is not a promise that nothing leaves the machine: a stdio wrapper around a cloud API sends its arguments out too. "Allow in this chat" on the prompt silences the prompts of that one tool of that server for the rest of the session; the server's other tools and other servers' tools still ask (ATO-1473).

Per-server approval mode (ATO-1134): `mcp.servers[].approval` in `config.json` replaces the answer above for that server's tools ([mcp-approval-mode.ts](mcp-approval-mode.ts)). `ask`: the default `approval_gated` behaviour, also on a `pure_read` server. `ask_writes`: a tool whose discovery-time `readOnlyHint` is `true` runs unasked only on a stdio server; every other tool asks, and so does every tool of a remote HTTP / SSE server, including the agent's own `trustedReadOnlyTools` exceptions (ATO-1178). `auto`: no prompt. Absent: `trust` decides, as before. `trust` still decides batching. A call a mode lets through that the default would have asked about still goes to the gate when a saved deny or ask rule names it (`savedRuleOverridesScope`).
