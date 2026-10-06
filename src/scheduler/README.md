# Scheduler

Status: current
Owner: src/scheduler/

Owns due-task polling, skips re-entry and waits for in-flight drain at stop. Does not own per-session state or bypass runtime FIFO.

Entry point: [scheduler.ts](scheduler.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/scheduler` when tests are present; `npm run lint`; `npm run docs:check`.
