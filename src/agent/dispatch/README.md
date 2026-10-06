# Batch gates and scheduling

Status: current
Owner: src/agent/dispatch/

Read [agent instructions](../AGENTS.md) and the [module route](../README.md). Entry: [batch-scheduler.ts](batch-scheduler.ts).

batch-gates.ts owns synchronous refusals and loop check/record before any invocation. batch-scheduler.ts owns resource grouping, fanout, serial cancellation and the terminal-tail barrier. batch-contract.ts contains type-only contracts. Results retain emitted index order; ordinary tool failure does not cancel siblings. batch-executor.ts is a compatible named-export facade.

Checks: `npx vitest run src/agent`; `npm run lint`; `npm run typecheck:tests`. Read [batching](../docs/batching.md) for dispatch or [recovery](../docs/recovery.md) for retries and progress.
