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
- [task-pause.ts](task-pause.ts)
- [task-run-summary.ts](task-run-summary.ts)
- [task-report-hold.ts](task-report-hold.ts)
- [task-run-log.ts](task-run-log.ts)
- [task-heartbeat.ts](task-heartbeat.ts)

## Ownership and dependencies

TaskStore owns the durable queue, TaskRunner owns claiming/execution/retry/reporting, and schedule/backoff helpers compute eligibility. The scheduler submits work through runtime; channels and HTTP can create tasks. A queued task is durable state rather than an in-memory timeout, and stopping producers is part of runtime shutdown.

## Pause, resume and run history

An operator can pause a waiting task (`pending` -> `paused`) and resume it (ATO-590): `TaskStore.pause` / `resume`, `POST /api/tasks/:id/pause|resume`, `task pause|resume <id>`. Every query that finds work reads `pending` rows only, so a paused task never fires; a resumed recurring task is armed for its next firing after the resume and missed firings are skipped. A running task cannot be paused. "Run now" (`runOne` with `evenIfPaused`, which `POST /api/tasks/:id/run`, `task run <id>` and the TUI use) runs a paused task once and puts it back to `paused` afterwards; a one-shot task that the run ends for good stays ended. Each claim also writes a row to `task_runs` in the same file ([task-run-log.ts](task-run-log.ts)): start, end, outcome, error and session, newest first through `listRuns`, `GET /api/tasks/:id/runs` and `task runs <id>`, at most 200 per task. The table sits outside the numbered migrations, like `run_owner`, and the history is best effort: a write that fails never fails the transition it follows.

## Resuming an interrupted run

A run cut off from outside (the boot sweep took it back from a dead process, or a shutdown left a one-shot task due) is continued from its session's checkpoint rather than started over ([task-resume.ts](task-resume.ts), ATO-1109): the turn's message starts with a note saying how far the cut-off run got, and the session's progress marker records the task id and the resumes spent. Resumes after a crash or kill count towards `agent.task.maxResumes` and back off on the retry curve; past the limit the task fails with a sentence saying why. A run a person stopped is never resumed. `agent.task.resumeInterrupted: false` restores the fresh re-run.

## Pausing a recurring task

A recurring task can be paused and resumed ([task-pause.ts](task-pause.ts), ATO-21; Telegram's `/cron pause|resume` uses it). It is a thin layer over the queue's own `paused` state (`TaskStore.pause` / `resume`, ATO-590) that returns a refusal reason instead of throwing and only takes recurring tasks; a run in progress is refused. Resume arms the next firing after now, so firings that fell inside the pause are skipped. Delete is the plain cancel.

## Task board

The board (ATO-2257, after Vibe Kanban and the Hermes/OpenClaw workboards) shows every task as a card in one of five lanes: `todo`, `doing`, `review`, `blocked`, `done` ([task-board-lanes.ts](task-board-lanes.ts)). It is a view over the queue, not a second status machine: a card's lane comes from the task's status (`pending`/`paused` to todo, `running` to doing, `failed`/`blocked` to blocked, `completed`/`cancelled` to done) unless someone moved it, and moving a card never claims, runs, pauses or ends the task. A lane someone set holds until the task starts a new run after the move, so a card put in review stays there when its run completes while a card run again follows its status. Each card can also carry a note and an assignee (an agent profile name, a label for now). They live in the `task_board` table of `tasks.sqlite` ([task-board.ts](task-board.ts)), added outside the numbered migrations like `task_runs`; when it cannot be added the board is off and cards sit in their status lanes. Rows of tasks deleted with their session go too. Surfaces: `TaskStore.boardCards` / `updateBoardCard`, `GET /api/task-board`, `POST /api/tasks/:id/board`; "Run now" is the existing `POST /api/tasks/:id/run`.

Each card keeps a comment thread (ATO-2497, [task-board-comments.ts](task-board-comments.ts), table `task_board_comments`, at most 200 per card), written by the agent, a person or the runner. While a task runs, the agent has three tools on its own card ([tasks-board-card.ts](../tools/tasks/tasks-board-card.ts), after the Hermes kanban tools): `tasks.request_review { note? }` moves it to review, `tasks.block { reason }` to blocked, `tasks.comment { text }` adds a comment. The card is the task `TaskRunner.runningTaskInSession` names for the calling session. A turn that runs no task (no `checkpoint.taskId`) does not get them: [board-card-visibility.ts](../tools/tasks/board-card-visibility.ts) hides them from its catalog, wire and grammar, the way `ask_user` is hidden. A card the agent blocked during a run is paused when that run leaves the task waiting again (a retry, a recurring task's next firing), and the failure fuse ([task-board-fuse.ts](task-board-fuse.ts)) pauses a task whose last 3 runs all failed, moves its card to blocked and says why in a comment. Running it again ("Run now", resume) starts a fresh count.

## Suggestions (ideas)

The agent offers small cards built from its own records ([idea-rules.ts](idea-rules.ts), ATO-458): a task that failed or was blocked in the last 7 days and was never run again (no later task with the same message), and a chat goal that stopped paused or out of rounds in the last 14 days with checklist items open. Fixed rules, no model call, nothing sent anywhere; at most 5 undecided cards of each kind wait at once, counted after decided sources are set aside (dismissed cards take no slot, and a waiting card is never pushed out by newer ones). Each card has a reason, evidence (the task id or chat id with a short excerpt: the error, the open items) and a ready prompt. They live in the `ideas` table of `tasks.sqlite` ([idea-store.ts](idea-store.ts)); `source_key` is unique, so a source that has had a card, accepted or dismissed, never gets another. A refresh adds cards for new sources and removes undecided ones whose source no longer qualifies. Accepting flips the card first (compare-and-swap), then files an ordinary task with the (optionally edited) prompt and links it; a Retry card's task keeps the original's `maxSteps`, `maxCostUsd`, `maxDurationMs` and `notify` and runs in a new chat opened in the original chat's folder (the original task id is on the card as `sourceTaskId`); a refused task puts the card back ([idea-service.ts](idea-service.ts)). Surfaces: `atomic-agent ideas` and `/api/ideas`. Mail is not a source: the inbox is read live and nothing of it is stored.

## Task-specific reading

Read docs/queue.md and ../scheduler/README.md for schedule/drain edits; ../http/AGENTS.md for webhooks.

## Validation

`npx vitest run src/tasks`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
