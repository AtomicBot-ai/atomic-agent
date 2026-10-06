# Turn preparation, recovery and finalization

Status: current
Owner: src/agent/turn/

Read [agent instructions](../AGENTS.md) and the [module route](../README.md). Entry: [turn-preparation.ts](turn-preparation.ts).

Synchronous preparation surrounds the original memory/profile awaits in agent-loop.ts. turn-state.ts owns the mutable counters and retry state; turn-recovery.ts classifies failures and returns a narrow decision. Waiting remains explicit in the loop. turn-memory-context.ts owns recalled context and its allowlists; turn-finalization.ts records the existing completion/failure effects and drains steering. Parse, empty, size and truncation helpers are the sole rule owners.

Checks: `npx vitest run src/agent`; `npm run lint`; `npm run typecheck:tests`. Read [batching](../docs/batching.md) for dispatch or [recovery](../docs/recovery.md) for retries and progress.
