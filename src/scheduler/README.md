# Scheduler

Status: current
Owner: src/scheduler/

Owns due-task polling, skips re-entry and waits for in-flight drain at stop. Does not own per-session state or bypass runtime FIFO.

Processes sharing one state dir (the desktop's `atag serve` and the TUI, ATO-416) each run a scheduler; [leadership](scheduler-leadership.ts) lets only one drain on interval ticks: the live `telegram.lock` holder when this process wants Telegram, otherwise the holder of `<stateDir>/scheduler.lock` (waiters take over when the holder exits or its pid dies). A single process always leads; an explicit `tickOnce` is not gated; `stop` releases the lock after the drain.

`sidecars` is periodic work that must run in the leading process only, ticked after the leadership check on each interval tick (not on `tickOnce`): today the [mail trigger](../atomic-mail/README.md) (ATO-601). Each sidecar throttles itself; a rejection is logged.

Entry point: [scheduler.ts](scheduler.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/scheduler` when tests are present; `npm run lint`; `npm run docs:check`.
