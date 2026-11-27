import { readLogbookSettings, reconcileStandup, STANDUP_CHECK_EVERY_MS, type StandupTasks } from "../../logbook/index.js";
import { renderRecipePrompt, STANDUP_RECIPE } from "../../recipes/index.js";
import type { TaskRunner, TaskStore } from "../../tasks/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

/**
 * ATO-2526: the logbook's morning standup through the existing
 * scheduler. Checked once a minute in the process that captures; the
 * task itself runs wherever the task runner runs it, like any cron task.
 */
export interface RuntimeStandupTasks {
  runner: Pick<TaskRunner, "create" | "cancel">;
  store: Pick<TaskStore, "get">;
}

export function standupTasks(tasks: RuntimeStandupTasks, timeZone: string): StandupTasks {
  return {
    createDaily: (cron, message) =>
      tasks.runner.create({
        userMessage: message,
        origin: "sidecar",
        triggerSource: "scheduler",
        maxAttempts: 1,
        schedule: { kind: "cron", expression: cron, tz: timeZone },
      }).id,
    cancel: (id) => {
      tasks.runner.cancel(id);
    },
    isLive: (id) => {
      const record = tasks.store.get(id);
      return record !== null && record.status !== "cancelled";
    },
  };
}

/** The standup recipe for yesterday's notes: the text the task sends. */
export function standupMessage(): string {
  return renderRecipePrompt(STANDUP_RECIPE, { day: "yesterday" });
}

/** A per-tick check, throttled to once a minute; never throws. */
export function createStandupCheck(args: {
  stateDir: string;
  tasks: RuntimeStandupTasks;
  logger: Pick<StructuredLogger, "warn">;
  timeZone?: string;
}): (now: number) => void {
  const tz = args.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tasks = standupTasks(args.tasks, tz);
  let lastAt: number | null = null;
  return (now) => {
    if (lastAt !== null && now - lastAt < STANDUP_CHECK_EVERY_MS) return;
    lastAt = now;
    try {
      reconcileStandup(args.stateDir, readLogbookSettings(args.stateDir), tasks, standupMessage());
    } catch (err) {
      args.logger.warn("logbook: standup schedule failed", { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
