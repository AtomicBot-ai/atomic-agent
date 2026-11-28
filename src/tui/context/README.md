# Context usage readout and controls

Status: current
Owner: src/tui/context/

Read the inherited [TUI instructions](../AGENTS.md) and [interface contract](../docs/interface.md).

## Ownership and entry points

[context-chip.tsx](context-chip.tsx) and [context-panel.tsx](context-panel.tsx) show the latest prompt/window/transcript budget. [select-context-usage.ts](select-context-usage.ts) resolves view data and pair-count projections; [context-panel-keys.ts](context-panel-keys.ts) owns the local close/count-control input. Their tests, including usage-at-pairs.test.ts, live here.

The panel lists each section's `parts` (prefix sections, built-in tools, one row per MCP server; measured in [prompt-breakdown.ts](../../prompt/prompt-breakdown.ts)) indented under it when the pane has room, and sheds them before anything else. The native `tools` array (`tool schemas` row) gets the same parts on a `native_tools` link (ATO-2453). With `d` in the panel or `/context detail`, [context-panel-body.ts](context-panel-body.ts) also lists each MCP server's tools under its part, biggest first, folding the rest into one `+N more` row on a short pane; every open from the chip or `/context` starts folded. [context-hint.ts](context-hint.ts) adds one two-line tip on a window of 64k or less when an MCP server, or the built-in catalog with `tool.search` off, takes more than 10% of it.

The actual snapshot/projection belongs to [session/context-usage.ts](../../session/context-usage.ts), not the display. The pre-existing [TUI facade](../context-usage-from-prompt.ts) stays unchanged. [TuiState](../tui-state.ts), [agent-event-reducer](../agent-event-reducer.ts) and [reduce-ui-actions](../reduce-ui-actions.ts) own state/events; [TuiApp](../tui-app.tsx) and [global keys](../app-key-bindings.ts) compose panel/chip and callbacks. Persistence remains with their existing callback/command owners. Pair-count adjustment must not invent a new prompt or report an unknown window as known.

## Checks and limits

`npx vitest run src/tui/context/ src/tui/context-usage-from-prompt.test.ts src/tui/agent-event-reducer.test.ts src/tui/tui-app.test.tsx`. Existing assertions cover selectors, cap attribution, count projections, readout and input; no prompt/runtime algorithm changes are part of relocation. Run `npm run lint`, `npm run typecheck:tests` and `npm run imports:check` after changing interfaces; `npm run docs:check` for navigation.
