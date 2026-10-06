# Terminal UI state and input

Status: current
Owner: src/tui/

TuiApp composes the Ink surface, reducers fold UI/agent actions, and feature orchestrators coordinate external work. [The TUI map](../README.md) routes to every feature guide; specialized views live with their owners. [Shared primitives and shell composition](../components/README.md) explains why generic editor/list/logo differ from sidebar/status/composer/debug composition. Global state, actions, event reducer, input precedence and session/runtime coordination remain at the root.

Preserve input precedence between editor, modal, menu and panel. Mouse routes synthesize the same transitions as keyboard routes; terminal selection passthrough, keyboard capabilities and terminal restoration are platform-sensitive. Layout must respect small terminals and measured rows.

[Issue-report](../issue-report/README.md) and [uninstall](../uninstall/README.md) keep modal presentation and their local input handlers together. Global app-key-bindings still decides when to delegate; the type-only state/dispatch/callback context does not transfer global precedence or runtime resource ownership to those handlers. Existing tests enter through the global router, and uninstall editor-focus tests remain beside TuiApp.

Live turns can belong to sessions other than the selected chat. Preserve turn marks, detached-turn attribution, worker model attribution, replayed messages, attachments and approval ownership. Settings changes must use the validated persistence paths; provider hot-swap is a live runtime operation.

Sources: [app](../tui-app.tsx), [state](../tui-state.ts), [agent reducer](../agent-event-reducer.ts), [keys](../app-key-bindings.ts), [mouse](../mouse/index.ts), [chat orchestrator](../chat-orchestrator.ts). Tests: [reducer](../agent-event-reducer.test.ts), [keys](../app-key-bindings.test.ts). Operator usage: [TUI guide](../../../docs/user/tui.md).

## Update presentation

[Update UI](../update/README.md) owns offer keys and four views. Global composition retains approval precedence, update state/reducer, installer coordination and post-exit restart.
