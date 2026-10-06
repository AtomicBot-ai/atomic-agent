# MCP terminal interface

Status: current
Owner: src/tui/mcp/

Inherit [TUI instructions](../AGENTS.md); read [MCP instructions](../../mcp/AGENTS.md) for manager/transport contracts. This area owns the MCP panel's views, state, input and orchestration. [Shared persistence](../../config/mcp-server-commands.ts) belongs to config and is also used by HTTP.

## Entry points and state

- [Panel](mcp-panel.tsx) composes [list](mcp-list.tsx), [detail](mcp-detail.tsx), [add editor](mcp-add-modal.tsx) and [remove confirmation](mcp-remove-modal.tsx).
- [Panel state](mcp-panel-state.ts) and [actions](mcp-actions.ts) define the UI projection; [reducer](mcp-reducer.ts) changes it without external work.
- [Keys](mcp-key-bindings.ts) own list/detail/modal routing. List mouse activation uses the same handler. Add-modal keys fall through to the shared MultiLineEditor; remove confirmation retains its own target even if the list cursor changes.
- [Orchestrator](mcp-orchestrator.ts) reads current config and live manager catalogs, emits actions and owns the refresh interval and same-server busy guard. Its typed dependency surface derives only the six used manager methods and runtime.refreshMcp from AgentRuntime. It owns neither manager transports nor inference resources.

## External composition and effects

DebugPane mounts the panel, TuiState/TuiAction and the root reducer compose its state, and TuiApp/tui-command connect input/callbacks. ChatOrchestrator constructs and shuts down the MCP orchestrator. These callers import named files; no barrel or compatibility forwarding module is required.

Writes run before live changes. Add/remove success closes the relevant dialog once config has been written; a subsequent connection failure is reported separately and does not pretend to roll back the file. Restart/toggle for the same server share a busy guard. The manager owns catalog discovery and dynamic registration; refreshMcp rebuilds the runtime's exposed tool catalog after live changes. Read [MCP client lifecycle](../../mcp/docs/client.md) before changing that boundary.

## Checks

Run `npm run test:ci -- src/tui/mcp/` for reducer, keys, orchestrator and panel input seams. For persistence/HTTP changes also run the [config suite](../../config/mcp-server-commands.test.ts) and [HTTP route suite](../../http/route-mcp.test.ts); HTTP tests need local loopback listeners. [Panel tests](mcp-panel.test.tsx) use real Ink input/hit testing and typed UI state. [Orchestrator tests](mcp-orchestrator.test.ts) use temporary state, typed manager methods and fake timers, without server processes.

Run `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`. Full integration uses `npm run test:ci`; see [local CI](../../../docs/testing/local-ci.md). The checker now has no ownership exceptions, including HTTP → TUI.
