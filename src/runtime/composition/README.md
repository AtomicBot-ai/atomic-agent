# Internal runtime composition

Status: current
Owner: src/runtime/

[Bootstrap](../bootstrap.ts) owns ordering and the public facade. These modules are construction recipes, not a service locator or a public barrel. External consumers use bootstrap's API and [runtime-contract](../runtime-contract.ts); the import checker prevents inward imports of these recipes and any recipe dependency on bootstrap. The contract has type-only imports.

## Owners and task routes

- Add bootstrap tool integration: [tool registry/catalog](runtime-tool-catalog.ts), [skills](runtime-skills.ts), their adjacent tests and [tool composition seam](../tool-contract-composition.test.ts). Registration preserves core → vision → MCP → task → fusion → read confinement. Catalog owners rebuild skills and MCP at their original refresh phases.
- Change provider hot swap: [local profile](runtime-local-profile.ts), [inference wiring](runtime-inference.ts), adjacent tests and [fallback seams](../llm-fallback-seam.test.ts). Local profile preparation precedes stores; provider construction follows grammar/profile connection. Existing fallback, profile manager and context modules retain their algorithms.
- Fix a sidecar locked turn: [session factories/recovery](runtime-session-services.ts), [turn service](runtime-turn-service.ts), adjacent tests, [FIFO](../turn-controller.ts) and [sidecar concurrency tests](../../sidecar/send-message-concurrency.test.ts). runTurn queues; executeTurn requires a lock already held. Keep these two entry points distinct.
- Change memory sub-call cancellation: [store construction](runtime-memory-stores.ts), [services/consolidation](runtime-memory-services.ts), adjacent tests and [memory seams](../bootstrap-memory-health.test.ts). Borrowed SQLite handles and separate sub-call slots are described in [lifecycle](../docs/lifecycle.md).
- Fix a shutdown channel/store race: [task resources](runtime-task-services.ts), [channels](runtime-channels.ts), [lifecycle](runtime-lifecycle.ts), their adjacent tests and [bootstrap tests](../bootstrap.test.ts). Channels receive the stable facade, then immediately connect the corresponding shutdown reference before start. Scheduler start remains in bootstrap after channel construction.
- Change telemetry or event routing: [observability](runtime-observability.ts), [trace state/routing](runtime-traces.ts) and adjacent tests. Error handlers remain process-wide bootstrap actions; trace state and session pins remain runtime-local.

## Phase and state constraints

Bootstrap awaits local preparation, skills seeding/discovery, memory stores and probes, local profile/provider connection, and MCP startup at their original positions. It does not parallelize construction. Session recovery/pruning precedes task/webhook store construction. Memory services, loop, turn service and task runner are then connected. Consolidation starts before facade/channel assembly; scheduler starts after channels.

Catalog entries, dropped skill count, loop grammar, transport and serving-provider capabilities are read through live callbacks. runtime.grammar remains a plain boot snapshot; the loop's MCP grammar is live and the local profile manager retains its separate grammar state. Turning the public field into a getter would change the contract. Memory's tool-transport posture is the original boot snapshot; completion and side-call slot resolution remain callbacks.

Each component receives the shared handles it actually needs. The channel recipe intentionally receives the complete public facade; other recipes use named handles and narrow callbacks. [Normal teardown](../docs/lifecycle.md) preserves current order and limitations, including the absence of universal startup rollback.

## Checks

`npx vitest run src/runtime/ src/sidecar/ src/http/route-sessions.test.ts`; `npm run lint`; `npm run typecheck:tests`; `npm run imports:check`; `npm run docs:check`. Public contract, phase and catalog equivalence evidence is recorded in [stage 06 acceptance](../../../docs/testing/stage-06-validation.md).
