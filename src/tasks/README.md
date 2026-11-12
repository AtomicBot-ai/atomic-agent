# Durable task queue

Status: current
Owner: src/tasks/

This area owns durable task queue. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [task-store.ts](task-store.ts)
- [task-runner.ts](task-runner.ts)
- [task-types.ts](task-types.ts)
- [task-schedule.ts](task-schedule.ts)
- [task-resume.ts](task-resume.ts)
- [task-run-summary.ts](task-run-summary.ts)
- [task-report-hold.ts](task-report-hold.ts)

## Ownership and dependencies

TaskStore owns the durable queue, TaskRunner owns claiming/execution/retry/reporting, and schedule/backoff helpers compute eligibility. The scheduler submits work through runtime; channels and HTTP can create tasks. A queued task is durable state rather than an in-memory timeout, and stopping producers is part of runtime shutdown.

## Resuming an interrupted run

A run cut off from outside (the boot sweep took it back from a dead process, or a shutdown left a one-shot task due) is continued from its session's checkpoint rather than started over ([task-resume.ts](task-resume.ts), ATO-1109): the turn's message starts with a note saying how far the cut-off run got, and the session's progress marker records the task id and the resumes spent. Resumes after a crash or kill count towards `agent.task.maxResumes` and back off on the retry curve; past the limit the task fails with a sentence saying why. A run a person stopped is never resumed. `agent.task.resumeInterrupted: false` restores the fresh re-run.

## Suggestions (ideas)

The agent offers small cards built from its own records ([idea-rules.ts](idea-rules.ts), ATO-458): a task that failed or was blocked in the last 7 days and was never run again (no later task with the same message), and a chat goal that stopped paused or out of rounds in the last 14 days with checklist items open. Fixed rules, no model call, nothing sent anywhere; at most 5 of each kind. Each card has a reason, evidence (the task id or chat id with a short excerpt: the error, the open items) and a ready prompt. They live in the `ideas` table of `tasks.sqlite` ([idea-store.ts](idea-store.ts)); `source_key` is unique, so a source that has had a card, accepted or dismissed, never gets another. A refresh adds cards for new sources and removes undecided ones whose source no longer qualifies. Accepting flips the card first (compare-and-swap), then files an ordinary task with the (optionally edited) prompt and links it; a refused task puts the card back ([idea-service.ts](idea-service.ts)). Surfaces: `atomic-agent ideas` and `/api/ideas`. Mail is not a source: the inbox is read live and nothing of it is stored.

## Task-specific reading

Read docs/queue.md and ../scheduler/README.md for schedule/drain edits; ../http/AGENTS.md for webhooks.

## Validation

`npx vitest run src/tasks`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
