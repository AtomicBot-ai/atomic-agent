# Runtime assembly and ownership

Status: current
Owner: src/runtime/

This area owns runtime assembly and ownership. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [bootstrap.ts](bootstrap.ts)
- [runtime-contract.ts](runtime-contract.ts): public types, re-exported by bootstrap for existing consumers.
- [composition/README.md](composition/README.md): internal construction phases and component owners.
- [turn-controller.ts](turn-controller.ts)
- [steering-inbox.ts](steering-inbox.ts)
- [llm-fallback-seam.ts](llm-fallback-seam.ts)

## Ownership and dependencies

Bootstrap orders construction phases, assembles AgentLoop dependencies and returns the public runtime. Internal composition components hold catalog, trace, telemetry and turn state; they receive named dependencies and callbacks. They cannot import bootstrap, and consumers outside bootstrap cannot import them. TurnController owns per-session FIFO scheduling; SteeringInbox owns pending corrections. The runtime supplies live getters to consumers so a provider or tool change can take effect without rebuilding every frontend. [Lifecycle](docs/lifecycle.md) documents resource ownership, shutdown order and existing failed-start limits.

For tool integration read composition/runtime-tool-catalog.ts; for provider hot swap read composition/runtime-inference.ts and runtime-local-profile.ts. For sidecar locking read composition/runtime-turn-service.ts and turn-controller.ts. For memory sub-call cancellation read composition/runtime-memory-services.ts. For a channel/store shutdown race read composition/runtime-lifecycle.ts and docs/lifecycle.md. [Component routes and tests](composition/README.md) link each task to its owner.

## Task-specific reading

Read docs/lifecycle.md before changing ownership, shutdown or steering; ../llm/docs/fallback.md before changing fallback wiring.

## Validation

`npx vitest run src/runtime`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
