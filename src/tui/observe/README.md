# Observation views

Status: current
Owner: src/tui/observe/

Read the inherited [TUI instructions](../AGENTS.md) and [interface contract](../docs/interface.md).

## Ownership and entry points

[event-feed.tsx](event-feed.tsx), [logs-tab.tsx](logs-tab.tsx), [reasoning-tab.tsx](reasoning-tab.tsx) and [world-panel.tsx](world-panel.tsx) display bounded projections of runtime events, logs, reasoning and the world snapshot. They create no polling or subscription resources. Feed/log/reasoning tails retain maxVisible and existing clipping; world rendering retains its snapshot limits.

[DebugPane](../components/debug-pane.tsx) selects and budgets these panels. [TuiState](../tui-state.ts) owns their arrays/snapshot and [agent-event-reducer](../agent-event-reducer.ts) folds events. Structured logging belongs to [tracing](../../tracing/README.md). Managed-server logs are separately owned by [local-models](../local-models/README.md).

## Checks and limits

`npx vitest run src/tui/components/debug-pane-budget.test.ts src/tui/agent-event-reducer.test.ts src/tui/tui-app.test.tsx`. These cover composition/event seams; there are no dedicated suites for the four observation renderers and no claim of full rendering coverage. Run `npm run lint`, `npm run typecheck:tests` and `npm run imports:check` after changing interfaces; `npm run docs:check` for navigation.
