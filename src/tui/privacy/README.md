# Privacy settings panel

Status: current
Owner: src/tui/privacy/

Read the inherited [TUI instructions](../AGENTS.md) and [interface contract](../docs/interface.md).

## Ownership and entry points

[components/privacy-panel.tsx](components/privacy-panel.tsx), privacy-panel-state/actions/reducer and [privacy-key-bindings.ts](privacy-key-bindings.ts) own panel presentation and pure transitions. [PrivacyOrchestrator](privacy-orchestrator.ts) persists analytics.enabled through the existing [persistence helper](../persist-analytics-enabled.ts), invalidates config and hot-applies runtime settings. Its refresh mirrors live approval level and session grants rather than assuming saved configuration is live.

[DebugPane](../components/debug-pane.tsx) and [ChatOrchestrator](../chat-orchestrator.ts) compose this owner. Runtime owns analytics clients and approval grants. Keep persistence/live-operation failures visible and busy state settled. Existing local components/ depth is intentional; no flattening or permission-policy change is needed.

## Checks and limits

`npx vitest run src/tui/privacy/ src/tui/persist-analytics-enabled.test.ts`. Adjacent reducer, keys, component and orchestrator suites cover the existing contracts. Run `npm run lint`, `npm run typecheck:tests` and `npm run imports:check` after changing interfaces; `npm run docs:check` for navigation.
