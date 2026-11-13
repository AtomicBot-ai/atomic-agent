import { readFileSync } from "node:fs";

import type { StructuredLogger } from "../tracing/structured-logger.js";

import {
  buildHeartbeatPrompt,
  isHeartbeatSilent,
  isWithinActiveHours,
  type HeartbeatConfig,
  type HeartbeatOutcome,
} from "./task-heartbeat.js";
import type { HeartbeatStore } from "./task-heartbeat-store.js";
import type { TaskRecord } from "./task-types.js";

/**
 * The runner's side of a heartbeat (ATO-454): before a run, whether the
 * task is a heartbeat and what its turn is told; after it, whether the
 * reply is news worth delivering.
 */
export interface TaskHeartbeatOptions {
  store: HeartbeatStore;
  /** Test seam; production reads the file as UTF-8, `null` when it is missing. */
  readChecklist?: (path: string) => string | null;
  /** Desktop notification for news, when the heartbeat asks for one. */
  notifyDesktop?: (title: string, message: string) => void | Promise<void>;
  /** Test seam for the active-hours check and the prompt's time. */
  now?: () => Date;
}

export type HeartbeatPlan =
  | { kind: "none" }
  | { kind: "skip"; config: HeartbeatConfig; outcome: HeartbeatOutcome }
  | { kind: "run"; config: HeartbeatConfig; message: string };

/** Desktop notifications are cut to this many characters. */
const DESKTOP_MESSAGE_MAX_CHARS = 240;

/**
 * Whether `task` is a heartbeat and how to run it now. Only recurring
 * `interval` tasks are looked up; a store that cannot answer makes the
 * task an ordinary one, as before heartbeats existed.
 */
export function planHeartbeatRun(
  task: TaskRecord,
  options: TaskHeartbeatOptions | undefined,
  logger?: StructuredLogger,
): HeartbeatPlan {
  if (!options || !task.recurring || task.schedule?.kind !== "interval") {
    return { kind: "none" };
  }
  const at = options.now?.() ?? new Date();
  let config: HeartbeatConfig | null;
  try {
    config = options.store.get(task.id);
  } catch (err) {
    logger?.warn("could not read heartbeat settings; running the task as usual", {
      taskId: task.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: "none" };
  }
  if (config === null) return { kind: "none" };
  if (!isWithinActiveHours(config.activeHours, at)) {
    return { kind: "skip", config, outcome: "outside_active_hours" };
  }
  const read = options.readChecklist ?? readChecklistFile;
  const checklist = read(config.checklistPath);
  // Nothing to check is nothing to say: no turn, no model call.
  if (checklist === null || checklist.trim().length === 0) {
    return { kind: "skip", config, outcome: "no_checklist" };
  }
  return {
    kind: "run",
    config,
    message: buildHeartbeatPrompt({
      checklistPath: config.checklistPath,
      checklist,
      at,
    }),
  };
}

/**
 * After a completed heartbeat run: silent when the reply says nothing
 * new; otherwise the Telegram report goes out through `report` (the
 * runner's usual path, which honours the task's `notify`) and the
 * desktop notification when asked for. Returns the outcome recorded.
 */
export function finishHeartbeatRun(input: {
  task: TaskRecord;
  config: HeartbeatConfig;
  replyText: string | null;
  options: TaskHeartbeatOptions;
  report: () => void;
  at: number;
  logger?: StructuredLogger;
}): HeartbeatOutcome {
  const { task, config, replyText, options, logger } = input;
  const silent = isHeartbeatSilent(replyText);
  if (!silent) {
    input.report();
    if (config.osNotify && options.notifyDesktop && replyText !== null) {
      const message = replyText.trim().slice(0, DESKTOP_MESSAGE_MAX_CHARS);
      void (async () => options.notifyDesktop?.("Atomic Agent", message))().catch(
        (err) => {
          logger?.warn("heartbeat desktop notification failed", {
            taskId: task.id,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    }
  }
  const outcome: HeartbeatOutcome = silent ? "nothing_new" : "delivered";
  recordHeartbeatOutcome(options, task.id, outcome, input.at, logger);
  return outcome;
}

/** Bookkeeping only: a store that cannot write never fails the run. */
export function recordHeartbeatOutcome(
  options: TaskHeartbeatOptions,
  taskId: string,
  outcome: HeartbeatOutcome,
  at: number,
  logger?: StructuredLogger,
): void {
  try {
    options.store.recordOutcome(taskId, outcome, at);
  } catch (err) {
    logger?.warn("could not record the heartbeat outcome", {
      taskId,
      outcome,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function readChecklistFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
