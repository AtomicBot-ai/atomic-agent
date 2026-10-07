# Scheduled-task UI

Status: current
Owner: src/tui/tasks/

This feature displays schedules and observed firings and routes creation, cancellation and run-now requests to runtime. Read [TUI instructions](../AGENTS.md), [task instructions](../../tasks/AGENTS.md) and [runtime instructions](../../runtime/AGENTS.md) when changing those operations. TaskStore owns records; TaskRunner owns execution. Views own neither resource.

## Presentation and transitions

[TasksPanel](tasks-panel.tsx) composes [filter/status bar](tasks-filter-bar.tsx), [list](tasks-list.tsx), [detail](tasks-detail.tsx) and [create form](tasks-create-form.tsx). [DebugPane](../components/debug-pane.tsx) supplies state and list row allowance. [TuiApp](../tui-app.tsx) renders [cancel confirmation](tasks-cancel-modal.tsx) separately above the editor. Keep that composition and modal precedence.

[State](tasks-panel-state.ts), [actions](tasks-actions.ts), [reducer](tasks-reducer.ts) and [filter](tasks-filter.ts) own status/search, cursor, detail, form busy/error/preview and the anchored cancellation target. [Keys](tasks-key-bindings.ts) give confirmation first priority, then form, then detail/list input. Recurring cancellation opens confirmation; one-shot cancellation uses the existing direct callback. focusAfter is still exported by the create view and used by keys; relocation preserves that API and focus order. [Validation](tasks-form-validator.ts), [cron preview](cron-preview.ts) and [summary](tasks-summary.ts) retain their domain contracts.

TasksList currently uses its own cursor window and fixed padded/truncated columns; maxRows limits the row slice, with headings/arrows/hints rendered in addition. The separately tested [list-fit helper](tasks-list-fit.ts) is not used by TasksList. Its tests do not prove that the actual view fits every width/height; a layout correction requires a separate behavior change.

## Operations and resources

[TasksOrchestrator](tasks-orchestrator.ts) owns its refresh interval (default five seconds) and last-seen record map. It reads TaskStore, calls TaskRunner.create/runOne and TaskStore.cancel, emits UI actions and switches sessions through injected dependencies. shutdown clears the interval. Runtime continues to own store/runner lifetimes and execution cancellation; moving views changes none of these paths.

Detail firings are a bounded UI projection from observed record differences and the current record when opening detail. They are not a complete durable execution log. Clock/timezone/cron, claiming, retries and schedule persistence remain with the [task domain](../../tasks/README.md).

## Checks

Run `npx vitest run src/tui/tasks src/tui/memory src/tui/app-key-bindings.test.ts src/tui/app-key-bindings-selection.test.ts src/tui/tui-app.test.tsx src/tui/components/debug-pane-budget.test.ts`, then `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`. Use full `npm run test:ci` for cross-feature acceptance.

Six adjacent suites cover reducer, filter, list-fit helper, summary, form validation and cron preview. Existing app tests cover search and portions of input/composition, and DebugPane budget tests cover its allowance calculations. Dedicated tasks component, key-binding and orchestrator suites are absent; those pure tests do not verify live scheduling or all modal/form/rendering interactions. No real task execution or manual terminal verification is implied.
