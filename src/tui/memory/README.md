# Memory UI

Status: current
Owner: src/tui/memory/

This feature projects runtime memory into the terminal's memory tab. Read [TUI instructions](../AGENTS.md) and [memory instructions](../../memory/AGENTS.md) before changing reads or memory semantics. Durable profile, notes, lessons, procedures, links and votes belong to the domain stores assembled by runtime, not these views.

## Presentation and input

[MemoryPanel](memory-panel.tsx) composes the channel/status bar, [list](memory-list.tsx) and [detail](memory-detail.tsx). [DebugPane](../components/debug-pane.tsx) supplies the panel state and list row allowance. [State](memory-panel-state.ts), [actions](memory-actions.ts), [reducer](memory-reducer.ts) and [filter](memory-filter.ts) own channel selection, notes archive filter, search, cursor and list/detail transitions. The reducer stays pure.

[Keys](memory-key-bindings.ts) resolve the selected visible row, refresh, channel changes and note-neighbor navigation through TuiApp callbacks. Global input precedence remains with [app keys](../app-key-bindings.ts) and [TuiApp](../tui-app.tsx). The views do not add a separate mouse operation path. [Summary projection](memory-summary.ts) and [detail text](memory-detail-text.ts) translate store records into the UI payloads.

## Reads and resources

[MemoryOrchestrator](memory-orchestrator.ts) owns its refresh timer (default five seconds), remembers the last refresh options and reads runtime stores. It subscribes to memory refresh actions, emits loading/results/errors and prepares details and expanded neighbors. shutdown clears the interval; this move does not add subscription disposal or change store lifetimes. Config gates determine available channels and disabled-store hints. Notes search/archived listing and neighbor expansion retain their current limits and semantics; consult [domain mechanisms](../../memory/README.md) for storage, recall and consolidation.

## Checks

Run `npx vitest run src/tui/memory src/tui/tasks src/tui/app-key-bindings.test.ts src/tui/app-key-bindings-selection.test.ts src/tui/tui-app.test.tsx src/tui/components/debug-pane-budget.test.ts`, then `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`. Use full `npm run test:ci` for cross-feature acceptance.

[Filter tests](memory-filter.test.ts) and [reducer tests](memory-reducer.test.ts) cover pure selection/transitions, including unrelated-action fall-through. App tests cover portions of input/composition. There are no dedicated memory view or orchestrator suites; reducer tests do not verify live store reads, timer cleanup or exhaustive terminal rendering.
