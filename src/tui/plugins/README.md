# Plugins panel

Status: current
Owner: src/tui/plugins/

Read the inherited [TUI instructions](../AGENTS.md) and the [plugins domain guide](../../plugins/README.md).

## Ownership and entry points

`/plugins` (Manage → Plugins, `ctrl+g x`) lists every installed plugin: name, version, what it brings (skills, MCP servers, hooks, commands, subagents), whether it can run code and whether that code is allowed, and a "needs a key" mark when a switched-on MCP server is missing a variable. Enter opens a plugin's parts, each with its own switch; `c` allows (after a y/esc question) or stops the plugin's code; `d` removes it after a question.

Rows are the shared `PluginOverview` from [plugin-overview.ts](../../plugins/plugin-overview.ts), the same data `atomic-agent plugin list --json` prints for the desktop Plugins screen. [components/plugins-panel.tsx](components/plugins-panel.tsx), [state](plugins-panel-state.ts), [actions](plugins-actions.ts), [reducer](plugins-panel-reducer.ts) and [keys](plugins-key-bindings.ts) are pure. [PluginsOrchestrator](plugins-orchestrator.ts) is the only TUI module that reads or writes `<stateDir>/plugins/plugins.json`, and only through the plugins domain writers the CLI uses (`setPluginEnabled`, `setPluginPartEnabled`, `setPluginCodeAllowed`, `removePlugin`).

Installing is not part of this panel: the CLI and the marketplace flow own it. Skills follow switches on the next workspace refresh; MCP servers start on the next agent start, while turning a plugin or server off, stopping its code or removing it stops its running servers at once (the runtime watches `plugins.json`, [plugin-mcp-live.ts](../../plugins/plugin-mcp-live.ts)); the settled message says which.

## Checks

`npx vitest run src/tui/plugins src/plugins`, then `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`.
