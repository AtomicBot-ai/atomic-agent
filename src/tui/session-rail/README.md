# Session selection and rail layout

Status: current
Owner: src/tui/session-rail/

Read the inherited [TUI instructions](../AGENTS.md) and [interface contract](../docs/interface.md).

## Ownership and entry points

[session-picker.tsx](session-picker.tsx), [session-delete-modal.tsx](session-delete-modal.tsx), [session-rail-row.tsx](session-rail-row.tsx) and [pin-session-button.tsx](pin-session-button.tsx) own session-specific presentation. Local ordering/pinning, drag reducer, key handlers and layout persistence live here.

[SessionRailOrchestrator](session-rail-orchestrator.ts) remembers the emitted list and uses an injected layout store/entry loader; config persistence is in persist-session-rail.ts. [ChatOrchestrator](../chat-orchestrator.ts) owns actual session switching/deletion/replay and coordinates detached turns/approvals. [Sidebar](../components/sidebar.tsx) composes rail, navigation and tasks. Picker/delete state and submit/modal precedence remain in [TuiState](../tui-state.ts), [global keys](../app-key-bindings.ts), [submit](../submit-handler.ts) and [TuiApp](../tui-app.tsx).

Preserve anchored deletion target, pinned sessions missing from recent results, displayed-order move semantics, cancellation and reattachment. Rail layout does not become owner of session-store resources.

## Checks and limits

`npx vitest run src/tui/session-rail/ src/tui/chat-orchestrator-switch.test.ts src/tui/chat-orchestrator-rail-refresh.test.ts src/tui/components/sidebar.test.tsx`. Picker rendering tests moved here; global switching/focus/composition tests remain at their owners. Run `npm run lint`, `npm run typecheck:tests` and `npm run imports:check` after changing interfaces; `npm run docs:check` for navigation.
