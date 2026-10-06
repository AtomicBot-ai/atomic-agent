# Durable task queue

Status: current
Owner: src/tasks/

This area owns durable task queue. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [task-store.ts](task-store.ts)
- [task-runner.ts](task-runner.ts)
- [task-types.ts](task-types.ts)
- [task-schedule.ts](task-schedule.ts)

## Ownership and dependencies

TaskStore owns the durable queue, TaskRunner owns claiming/execution/retry/reporting, and schedule/backoff helpers compute eligibility. The scheduler submits work through runtime; channels and HTTP can create tasks. A queued task is durable state rather than an in-memory timeout, and stopping producers is part of runtime shutdown.

## Task-specific reading

Read docs/queue.md and ../scheduler/README.md for schedule/drain edits; ../http/AGENTS.md for webhooks.

## Validation

`npx vitest run src/tasks`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
