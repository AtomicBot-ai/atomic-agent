# Scheduler

Status: current
Owner: src/scheduler/

Owns due-task polling, skips re-entry and waits for in-flight drain at stop. Does not own per-session state or bypass runtime FIFO.

Processes sharing one state dir (the desktop's `atag serve` and the TUI, ATO-416) each run a scheduler; [leadership](scheduler-leadership.ts) lets only one drain on interval ticks: the live `telegram.lock` holder when this process wants Telegram, otherwise the holder of `<stateDir>/scheduler.lock` (waiters take over when the holder exits or its pid dies). A single process always leads; an explicit `tickOnce` is not gated; `stop` releases the lock after the drain.

File triggers (ATO-441): each `fileTriggers` entry in config.json watches one file or folder while this process leads (`onLeadershipChange`; leadership loss and `stop` close the watchers) and files a task with `triggerSource: "file"`, never calling `runTurn` itself. [Manager](file-trigger-manager.ts) caps watchers at 16 and refuses a filesystem root, the home directory and its parents ([guard](file-trigger-guard.ts)); a [watcher](file-trigger-watcher.ts) skips `node_modules`/`.git`, never fires for files already there at start, debounces per file, dedupes by path+mtime+size, and stops with a warning past `maxFiles` or on a watcher error. With `contains`, only bytes appended since the last look are read ([tail](file-trigger-tail.ts)). Production seams (chokidar, `node:fs`, timers) live in [file-trigger-chokidar.ts](file-trigger-chokidar.ts). Definitions are read at startup; edits apply on restart, like webhooks. Matched log lines go into the task prompt as data from the file.

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

Entry point: [scheduler.ts](scheduler.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/scheduler` when tests are present; `npm run lint`; `npm run docs:check`.
