# Durable queue, schedules and reports

Status: current
Owner: src/tasks/

TaskStore owns durable pending/running/terminal rows. TaskRunner claims due work, invokes runtime.runTurn and records the actual outcome. Recovering an orphan or retrying eligible work returns running to pending; a recurring completion requeues while preserving its session.

Scheduler owns due polling and avoids re-entry. Stop/drain must settle in-flight work before store closure. Schedule math, webhook wake reasons, session metadata and notification destinations are explicit records; UI is not the scheduling engine.

Sources: [store](../task-store.ts), [runner](../task-runner.ts), [schedule](../task-schedule.ts), [reports](../task-report.ts), [scheduler](../../scheduler/README.md). Tests: [runner](../task-runner.test.ts), [store](../task-store.test.ts), [scheduler](../../scheduler/scheduler.test.ts).
