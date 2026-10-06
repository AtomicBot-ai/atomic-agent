# Integrations hub

Status: current
Owner: src/tui/integrations/

Read the inherited [TUI instructions](../AGENTS.md) and [interface contract](../docs/interface.md).

## Ownership and entry points

[components/integrations-panel.tsx](components/integrations-panel.tsx), integrations-panel-state/actions/reducer and [integrations-key-bindings.ts](integrations-key-bindings.ts) own hub UI. [IntegrationsOrchestrator](integrations-orchestrator.ts) coordinates credential writes and live MCP/channel operations; GitHub and Atomic Mail operations have their own local helpers/tests.

Telegram setup/pairing is delegated to [telegram](../telegram/README.md), not copied into the hub. Runtime/domain owners retain MCP transports, primary channels and mail resources; [ChatOrchestrator](../chat-orchestrator.ts) composes their UI adapters and [DebugPane](../components/debug-pane.tsx) renders the hub. Credential presence and live/verified identity are distinct states; preserve failures and in-flight registration joining. Local components/ already belongs to this feature.

## Checks and limits

`npx vitest run src/tui/integrations/ src/tui/telegram/`. Tests use injected/mocked operations and temporary config; no real credential submission or service registration is required. Run `npm run lint`, `npm run typecheck:tests` and `npm run imports:check` after changing interfaces; `npm run docs:check` for navigation.
