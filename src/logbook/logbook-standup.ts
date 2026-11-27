import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureLogbookDir, logbookDir, type LogbookSettings } from "./logbook-settings.js";

/**
 * The morning standup (ATO-2526), opt-in. Settings say when
 * (`standupAt`, `HH:MM`); the loop that captures makes it so with the
 * existing scheduler: one recurring `cron` task that runs the standup
 * recipe every day at that time, in a chat of its own, listed with the
 * other scheduled tasks (where it can be paused or run now). Changing
 * the time replaces the task; turning the standup or the logbook off
 * cancels it. A task the person cancels themselves is not filed again
 * until the time changes. Which task is ours lives in `standup.json`,
 * written only here, so the CLI and the desktop write settings.json alone.
 */
export const LOGBOOK_STANDUP_FILE = "standup.json";
/** How often the loop compares settings with the task. */
export const STANDUP_CHECK_EVERY_MS = 60_000;

export interface StandupState {
  taskId: string | null;
  at: string | null;
}

export interface StandupTasks {
  /** Files the recurring task and answers its id. */
  createDaily: (cron: string, message: string) => string;
  cancel: (id: string) => void;
  /** The task still exists and is not cancelled. */
  isLive: (id: string) => boolean;
}

/** `HH:MM` into a daily cron expression, minute first. */
export function standupCron(at: string): string {
  const [h, m] = at.split(":").map((part) => Number(part));
  return `${m} ${h} * * *`;
}

export function readStandupState(stateDir: string): StandupState {
  try {
    const o = JSON.parse(readFileSync(join(logbookDir(stateDir), LOGBOOK_STANDUP_FILE), "utf8")) as Record<string, unknown>;
    return {
      taskId: typeof o.taskId === "string" && o.taskId.length > 0 ? o.taskId : null,
      at: typeof o.at === "string" ? o.at : null,
    };
  } catch {
    return { taskId: null, at: null };
  }
}

export function writeStandupState(stateDir: string, state: StandupState): void {
  const dir = ensureLogbookDir(stateDir);
  const target = join(dir, LOGBOOK_STANDUP_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

/** The time the standup should run at, or `null`: only while the logbook is on. */
export function wantedStandup(settings: LogbookSettings): string | null {
  return settings.enabled && settings.standupAt ? settings.standupAt : null;
}

/**
 * Make the task match the settings. Returns what changed:
 * `created`, `replaced`, `cancelled` or `none`.
 */
export function reconcileStandup(
  stateDir: string,
  settings: LogbookSettings,
  tasks: StandupTasks,
  message: string,
  io: { read?: typeof readStandupState; write?: typeof writeStandupState } = {},
): "created" | "replaced" | "cancelled" | "none" {
  const read = io.read ?? readStandupState;
  const write = io.write ?? writeStandupState;
  const current = read(stateDir);
  const want = wantedStandup(settings);
  const live = current.taskId !== null && tasks.isLive(current.taskId);
  // Same time as before: leave it. A task the person cancelled in the task list stays cancelled
  // until the time changes or the standup is turned off and on again.
  if (want === current.at) {
    if (current.taskId !== null && !live) write(stateDir, { taskId: null, at: want });
    return "none";
  }
  if (current.taskId !== null && live) tasks.cancel(current.taskId);
  if (want === null) {
    write(stateDir, { taskId: null, at: null });
    return current.taskId !== null && live ? "cancelled" : "none";
  }
  const taskId = tasks.createDaily(standupCron(want), message);
  write(stateDir, { taskId, at: want });
  return current.taskId !== null ? "replaced" : "created";
}
