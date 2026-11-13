# Overnight runs

Status: current
Owner: src/tasks/

Give the agent a long task, a money cap and a time cap, leave it alone, and read what it did when you come back.

## Start a run

```bash
atomic-agent overnight "migrate the tests to vitest" --budget 5 --hours 8 --dir /path/to/work
```

| Flag | What it does |
|---|---|
| `--budget <usd>` | Stop once the run has spent this many dollars. Without it, `agent.task.maxCostUsd` applies (`0`, the default, means no cap). |
| `--hours <h>` | Stop after this many hours. Default 8, from 1 minute (about `0.017`) to 24. |
| `--dir <path>` | The folder the run works in. Default: the current folder. |
| `--notify telegram` | Send the report to your paired Telegram chat when the run ends. |
| `--detach` | Run in the background. Prints the task id, the log path (`<stateDir>/logs/overnight-<id>.log`) and the command to check on it. |
| `--no-approval` | Allow every action for this run. Use it only in a folder you can throw away. |

`atag overnight` is the same command.

In the foreground you get one line per step, for example `[step 12 | 14m | $0.42 of $5.00] read src/app.ts`, and a summary at the end. Ctrl+C cancels the run; a second Ctrl+C quits. The summary says `overnight completed` when the agent finished on its own and `overnight stopped (<cause>)` when a limit ended the run. The exit code is 0 when the agent finished, 2 when it stopped at the budget, time or step limit, made no progress, or the provider ran out of credit (including a resume that found the budget or time already used), and 1 when the run failed or was cancelled.

With `--detach`, check on the run with `atomic-agent task show <id>` and stop it with `atomic-agent task cancel <id>`.

For night runs and scheduled tasks, turn on Keep awake (`ATOMIC_AGENT_TASKS_KEEP_AWAKE=while-working`, see [Sleep](#sleep)); it is off by default.

## Approvals

Nobody is there to answer, so nobody is asked. An action that needs approval is denied and the run carries on without it. Each denied action is printed as it happens (in the log file with `--detach`) and the summary at the end counts them; the Telegram report lists them under **Needs you**. `--no-approval` starts the run at the top approval level instead, which allows every action the shell guard does not block outright, including the commands that otherwise always ask.

## Limits

- **Money.** When the cap is reached the agent writes a short summary and stops with `stopped: spent $X of $Y budget`. Spend is an estimate from the provider's price list and counts the main agent loop only (not memory, compaction or Fusion workers), so a run can end slightly over the cap. Local models count as $0. In Fusion mode, paid workers (a cloud worker or role model, an escalation, the judge) are not in this figure at all and do not stop the run, so with them the run can end well over the cap. Cap them per turn with `llm.runMode.fusion.turnBudgetUsd`.
- **Time.** The run stops after `--hours`. If both caps are set, the first one reached ends the run.
- **Loops.** The loop guard leaves long normal work alone. Re-running the tests after an edit or polling a long build is fine. A poll that keeps getting the same answer is stopped after 20 identical answers, and the guard stops a real loop sooner.

Budgets work outside `overnight` too. `atomic-agent task create --max-cost-usd <n> --max-duration <dur>` sets them for one background task (`--max-duration` takes `90s`, `30m`, `8h` or `1h30m`). `agent.task.maxCostUsd` in `config.json` sets a default cap, and that cap applies to every turn, chats included.

## Reports

With `--notify telegram`, the report for a finished task lists **Done**, **Failed** and **Needs you**, with the number of steps, the time taken and why it stopped. `/status` in Telegram shows background tasks that are still running.

A report is sent when the task ends, even at 3 a.m. To hold reports at night, set `ATOMIC_AGENT_TASKS_REPORT_QUIET_HOURS=23:00-08:00` in the agent's environment. Held reports are sent together when the window ends: one held report goes out as a normal report, several come as a morning summary.

## Sleep

If the computer sleeps, a scheduled task that fell due meanwhile runs once when it wakes up (not once for every missed time). To keep the computer from sleeping in the first place, set `ATOMIC_AGENT_TASKS_KEEP_AWAKE` in the agent's environment:

| Value | What it does |
|---|---|
| `off` | Default. The computer may sleep; missed tasks catch up on wake. |
| `while-working` | Keep the computer awake only while a task or a chat turn runs. When the agent is idle the computer sleeps as usual. The screen can still turn off. |

Any other value (including the old `always`) is ignored with a warning in the log, and the agent behaves as `off`.

It uses `caffeinate` on macOS and `systemd-inhibit` on Linux (when installed); on Windows it does nothing. Closing a MacBook's lid still puts it to sleep: keep the lid open, or use an external display, for overnight runs.

## After a crash

Background tasks save a checkpoint after every step. If the agent crashes or is restarted, the task continues from the last finished step instead of starting over. This is on by default (`agent.task.resumeInterrupted`), up to `agent.task.maxResumes` times (default 3); after that the task is marked as given up. Interactive chats are not resumed this way. Resuming a terminal `overnight` run after a crash has not been tested yet, so do not count on it.

## Keep going until a checklist passes

`/goal` in the TUI gives the chat a checklist and keeps it working round after round until every item passes, it needs you, or it reaches 10 rounds:

```text
/goal tests pass; README lists the new flag; check: npm test
```

Items are split by `;` or one per line, and an item starting with `check:` is a command that must succeed. `/goal status`, `/goal pause`, `/goal resume` and `/goal clear` manage it. Each round costs a model call plus a judge call. `/goal` is TUI only and is not part of `overnight`.

## In the desktop app

Choose **Run overnight** in the composer's + menu, then give a task, a folder and a time limit (8 hours by default, up to 24). A small card in the corner shows the elapsed time and lets you open or stop the run. With Telegram paired, the report goes there. Keep the app open while it runs; closing the chat is fine. For night runs, turn on **Agent > Keep Computer Awake > While Working** so the computer does not sleep mid-run.
