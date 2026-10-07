# Swarm management panel

Status: current
Owner: src/tui/swarm/

Read the inherited [TUI instructions](../AGENTS.md) and [interface contract](../docs/interface.md).

## Ownership and entry points

[components/swarm-panel.tsx](components/swarm-panel.tsx), swarm-panel-state/actions/reducer and [swarm-key-bindings.ts](swarm-key-bindings.ts) own unit listing/edit/add/remove/pairing UI. [SwarmOrchestrator](swarm-orchestrator.ts) subscribes to runtime.swarm and owns the pairing refresh timer; dispose releases both. Local critter helpers and zergling-strip own decorative projections.

Runtime/channel registry owns bot/channel resources and persistence operations. Primary channels are read-only in this panel and remain owned by the [integrations hub](../integrations/README.md). [ChatOrchestrator](../chat-orchestrator.ts) and [DebugPane](../components/debug-pane.tsx) compose the feature. Preserve truth of status/attribution, busy guards and unsubscribe/timer lifecycle; views do not acquire channel ownership.

## Checks and limits

`npx vitest run src/tui/swarm/`. Existing local component/state/keys/orchestrator/critters suites remain in place; no directory flattening or live-bot QA is implied. Run `npm run lint`, `npm run typecheck:tests` and `npm run imports:check` after changing interfaces; `npm run docs:check` for navigation.
