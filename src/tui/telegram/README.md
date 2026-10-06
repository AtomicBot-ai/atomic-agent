# Telegram setup adapter

Status: current
Owner: src/tui/telegram/

Read the inherited [TUI instructions](../AGENTS.md) and [interface contract](../docs/interface.md).

## Ownership and entry points

[setup-state.ts](setup-state.ts), [setup-flow.ts](setup-flow.ts) and telegram-panel-state/actions/reducer own setup decisions and UI projection. [TuiTelegramOrchestrator](tui-telegram-orchestrator.ts) forwards channel status, coordinates token submission/connect/pairing and owns countdown/dismiss timers and its status subscription. shutdown releases those resources; its advancing guard prevents duplicate connect chains.

The [integrations hub](../integrations/README.md) presents and delegates setup; there is no separate standalone Telegram panel view here. Runtime/[Telegram channel](../../channels/README.md) owns channel resources and token-backed operations. Preserve rejected-token retry semantics, pairing ownership and token secrecy. [ChatOrchestrator](../chat-orchestrator.ts) composes the adapter.

## Checks and limits

`npx vitest run src/tui/telegram/ src/tui/integrations/`. Existing setup/flow/reducer/orchestrator suites remain beside their owner; live Telegram pairing was not performed. Run `npm run lint`, `npm run typecheck:tests` and `npm run imports:check` after changing interfaces; `npm run docs:check` for navigation.
