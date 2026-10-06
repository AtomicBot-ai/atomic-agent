# Update UI

Status: current
Owner: src/tui/update/

This feature owns update presentation and offer input. Read [TUI instructions](../AGENTS.md), [update domain guide](../../update/README.md) and [runtime instructions](../../runtime/AGENTS.md) for operation changes. It does not own another updater or duplicate global state.

[Offer](update-modal.tsx), [running indicator](update-indicator.tsx) and [restart prompt](update-restart-prompt.tsx) are composed by TuiApp. [Banner and width planner](update-banner.tsx) share the StatusBar row with DownloadChip. Dismissing the offer keeps the banner; running/done/failed state comes from TuiState/TuiAction and agent-event-reducer. Budget degradation and modal-layer click behavior remain unchanged.

[Local keys](update-key-bindings.ts) accept y, dismiss n/Escape and pass modified/other input through. They receive only dispatch/callback context via a type-only AppKeyContext dependency. [Global router](../app-key-bindings.ts) retains approval priority and the separate done/restart branch. The banner calls the same confirmation callback as the offer.

[ChatOrchestrator](../chat-orchestrator.ts) retains startup gates, silent version-check failure, active foreground/background-turn refusal and installer output/settlement. The [domain updater](../../update/run-app-update.ts) executes installation; [tui-command](../tui-command.ts) retains callbacks, fake-update simulation and post-exit restart. Shared spinner, mouse and palette resources retain their owners. Relocation changes no installer/cancellation/lifecycle policy.

Run `npx vitest run src/tui/update src/tui/components/status-bar-update.test.tsx src/tui/components/status-bar.test.tsx src/tui/agent-event-reducer.test.ts src/tui/app-key-bindings.test.ts src/tui/tui-app.test.tsx src/update`, then lint, typecheck:tests, imports:check, docs:check and full test:ci. [Offer tests](update-key-bindings.test.ts) enter through handleAppKey and verify approval/restart priority, including plain text versus approval Ctrl+Y. [Banner tests](update-banner.test.tsx) and StatusBar tests cover budgets/phases. Individual modal/indicator/restart suites and manual terminal/re-exec QA are absent; tests do not run a real installer.
