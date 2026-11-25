import { getConfig } from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import {
  pauseRecurringTask,
  resumeRecurringTask,
  type TaskPauseResult,
} from "../../tasks/index.js";

import type { CronTaskService } from "./cron-command.js";

/** How many recent tasks `/cron` looks through for scheduled ones. */
const LIST_SCAN_LIMIT = 500;

type RuntimeTasks = Pick<AgentRuntime, "taskRunner" | "taskStore" | "scheduler">;

/**
 * The `/cron` command's view of the runtime's task queue. Creates go
 * through `TaskRunner.create` exactly as `task create --cron` does
 * (same validation, same persistent session per recurring task), with
 * `notify: "telegram"` so every result is reported back, and
 * `origin: "telegram"`. `null` when the runtime has no task queue.
 */
export function cronTaskServiceFromRuntime(
  runtime: Partial<RuntimeTasks>,
  maxAttempts: () => number = () => getConfig().tasks.maxAttempts,
): CronTaskService | null {
  const runner = runtime.taskRunner;
  const store = runtime.taskStore;
  if (!runner || !store) return null;
  return {
    schedulerRunning: Boolean(runtime.scheduler),
    list: () => store.list({ limit: LIST_SCAN_LIMIT }),
    create: ({ expression, tz, message }) =>
      runner.create({
        userMessage: message,
        origin: "telegram",
        triggerSource: "user",
        maxAttempts: maxAttempts(),
        notify: "telegram",
        schedule: { kind: "cron", expression, ...(tz ? { tz } : {}) },
      }),
    pause: (id) => pauseRecurringTask(store, id),
    resume: (id) => resumeRecurringTask(store, id),
    remove: (id): TaskPauseResult => {
      const task = store.get(id);
      if (!task) return { ok: false, reason: "not_found", task: null };
      // `paused -> cancelled` is a store transition, so this covers a
      // paused task too. The runner's cancel also stops a run in progress.
      const cancelled = runner.cancel(id);
      if (cancelled?.status === "cancelled") return { ok: true, task: cancelled };
      return { ok: false, reason: "ended", task: cancelled };
    },
  };
}
