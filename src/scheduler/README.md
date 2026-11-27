# Scheduler

Status: current
Owner: src/scheduler/

Owns due-task polling, skips re-entry and waits for in-flight drain at stop. Does not own per-session state or bypass runtime FIFO.

Processes sharing one state dir (the desktop's `atag serve` and the TUI, ATO-416) each run a scheduler; [leadership](scheduler-leadership.ts) lets only one drain on interval ticks: the live `telegram.lock` holder when this process wants Telegram, otherwise the holder of `<stateDir>/scheduler.lock` (waiters take over when the holder exits or its pid dies). A single process always leads; an explicit `tickOnce` is not gated; `stop` releases the lock after the drain.

File triggers (ATO-441): each `fileTriggers` entry in config.json watches one file or folder while this process leads (`onLeadershipChange`; leadership loss and `stop` close the watchers) and files a task with `triggerSource: "file"`, never calling `runTurn` itself. [Manager](file-trigger-manager.ts) caps watchers at 16 and refuses a filesystem root, the home directory and its parents ([guard](file-trigger-guard.ts)); a [watcher](file-trigger-watcher.ts) skips `node_modules`/`.git`, never fires for files already there at start, debounces per file, dedupes by path+mtime+size, and stops with a warning past `maxFiles` or on a watcher error. With `contains`, only bytes appended since the last look are read ([tail](file-trigger-tail.ts)). Production seams (chokidar, `node:fs`, timers) live in [file-trigger-chokidar.ts](file-trigger-chokidar.ts). Definitions are read at startup; edits apply on restart, like webhooks. Matched log lines go into the task prompt as data from the file.

Hand-over (ATO-2508): the process that takes the lock starts its watchers on that tick, while the former leader closes its own only on its next tick, so for up to `tickMs` both watch. Each hit therefore re-asks leadership right before filing (`Scheduler.confirmLeadership`; a `false` answer also stands that process by at once) and takes a shared run record under `<stateDir>/file-trigger-claims/` keyed by trigger, path, mtime and size ([claims](file-trigger-claims.ts), exclusive create, pruned after a day, fails open). Watchers still start on the tick that gains leadership, so no hit is missed.

Example entry:

```json
"fileTriggers": {
  "inbox-pdfs": {
    "path": "~/Inbox",
    "glob": "*.pdf",
    "events": ["add"],
    "userMessageTemplate": "A new PDF arrived: {{path}}. Read it and file a short summary."
  },
  "app-errors": {
    "path": "~/logs/app.log",
    "events": ["change"],
    "contains": "ERROR",
    "debounceMs": 2000,
    "userMessageTemplate": "New errors in {{name}}:\n{{lines}}"
  }
}
```


`sidecars` is periodic work that must run in the leading process only, ticked after the leadership check on each interval tick (not on `tickOnce`, and not on the tick that gains leadership, so the previous leader has stood by first: #1735): today the [mail trigger](../atomic-mail/README.md) (ATO-601) and the [logbook](../logbook/README.md) capture loop (ATO-2363, macOS). Each sidecar throttles itself; a rejection is logged. The sidecar signal belongs to one leadership term: it is aborted when this process stops leading (ATO-2508) or stops, so a sidecar tick still running on a former leader quits; the task drain is not aborted on a hand-over, since claiming a task is atomic and stopping a running task turn would only restart it elsewhere.

[keep-awake.ts](keep-awake.ts) (ATO-592, `ATOMIC_AGENT_TASKS_KEEP_AWAKE`, default `off`): `while-working` holds `caffeinate -i -w <pid>` (macOS) or `systemd-inhibit` (Linux, when installed) for each task drain and each turn (`holdWhileRunning` around `runTurn`/`executeTurn` in bootstrap); there is no `always` mode, and the scheduler itself never holds; Windows has none. `poke()` (`POST /api/tasks/wake`, the desktop's resume signal) runs a gated tick at once.

Entry point: [scheduler.ts](scheduler.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/scheduler` when tests are present; `npm run lint`; `npm run docs:check`.
