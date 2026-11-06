# Durable queue, schedules and reports

Status: current
Owner: src/tasks/

TaskStore owns durable pending/running/terminal rows. TaskRunner claims due work, invokes runtime.runTurn and records the actual outcome. Recovering an orphan or retrying eligible work returns running to pending; a recurring completion requeues while preserving its session.

Scheduler owns due polling and avoids re-entry. Stop/drain must settle in-flight work before store closure. Schedule math, webhook wake reasons, session metadata and notification destinations are explicit records; UI is not the scheduling engine.

A task can carry its own budget (ATO-1108): `maxCostUsd` and `maxDurationMs` (`task create --max-cost-usd --max-duration`), stored in nullable columns added outside the numbered migrations like `run_owner`, so an older binary sharing the file keeps working. `null` leaves each to `agent.task.*`. The runner passes them to runTurn and adds each run's `spendUsd` to `spentUsd`; a retry gets only what earlier attempts left, and a task whose budget is used up is blocked instead of run again. A recurring task starts each firing with nothing spent. Unpriced (local) models count as $0, so a budget never stops local work. Rules: [budget](../task-budget.ts).

Sources: [store](../task-store.ts), [runner](../task-runner.ts), [schedule](../task-schedule.ts), [reports](../task-report.ts), [scheduler](../../scheduler/README.md). Tests: [runner](../task-runner.test.ts), [store](../task-store.test.ts), [scheduler](../../scheduler/scheduler.test.ts).
