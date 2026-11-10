import type Database from "better-sqlite3";

import { TaskValidationError, type TaskRecord } from "./task-types.js";

/**
 * Per-task budgets (ATO-1108): a spend ceiling, a wall-clock ceiling and
 * what the task's runs have used of them so far, as nullable `tasks`
 * columns.
 *
 * Added outside the numbered migrations, like `run_owner`: the desktop
 * and the terminal share one `tasks.sqlite`, and a binary that predates
 * these columns refuses a newer schema version, while extra nullable
 * columns it never names leave it working as before. Two processes can
 * open the file at once; the one that loses the race to add a column
 * finds it there.
 */
export const TASK_BUDGET_COLUMNS = [
  { name: "max_cost_usd", type: "REAL" },
  { name: "max_duration_ms", type: "INTEGER" },
  { name: "spent_usd", type: "REAL" },
  { name: "elapsed_ms", type: "INTEGER" },
  { name: "stop_cause", type: "TEXT" },
] as const;

/**
 * The approval level a task was started under (ATO-1324): the same kind
 * of nullable column older binaries ignore, added on its own so a
 * failure to add it never turns the budgets off. Returns why it is
 * missing, or `null` when it is there.
 */
export function ensureApprovalLevelColumn(db: Database.Database): string | null {
  try {
    const present = (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>)
      .some((column) => column.name === "approval_level");
    if (present) return null;
    try {
      db.exec(`ALTER TABLE tasks ADD COLUMN approval_level INTEGER`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/duplicate column/i.test(message)) throw err;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Give `tasks` its budget columns. Returns why they are missing (the
 * write lock was not granted, the file is read-only), or `null` when all
 * are there. Without them the store keeps working, but refuses to
 * create a task that asks for a budget rather than silently dropping it.
 */
export function ensureBudgetColumns(db: Database.Database): string | null {
  try {
    const present = new Set(
      (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    for (const column of TASK_BUDGET_COLUMNS) {
      if (present.has(column.name)) continue;
      try {
        db.exec(`ALTER TABLE tasks ADD COLUMN ${column.name} ${column.type}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/duplicate column/i.test(message)) throw err;
      }
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** `max_cost_usd`: a positive finite dollar amount, or `null` for none. */
export function validateMaxCostUsd(raw: number | null | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new TaskValidationError(
      "maxCostUsd",
      `maxCostUsd must be a positive number of dollars, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/** `max_duration_ms`: a positive integer, or `null` for none. */
export function validateMaxDurationMs(raw: number | null | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new TaskValidationError(
      "maxDurationMs",
      `maxDurationMs must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/** `approval_level`: an integer 1..5, or `null` for "any process may run it". */
export function validateApprovalLevel(raw: number | null | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  if (!Number.isInteger(raw) || raw < 1 || raw > 5) {
    throw new TaskValidationError(
      "approvalLevel",
      `approvalLevel must be an integer from 1 to 5, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * Whether a process at `processLevel` may claim `task` (ATO-1324). A
 * task that recorded the level it was started under runs only at that
 * level: an interrupted overnight run that denied what needed approval
 * must not be resumed by a process that would approve it, nor by one
 * that would ask a person who is not there.
 */
export function approvalLevelAllows(
  task: Pick<TaskRecord, "approvalLevel">,
  processLevel: number | undefined,
): boolean {
  const wanted = task.approvalLevel ?? null;
  return wanted === null || processLevel === undefined || processLevel === wanted;
}

/**
 * What the next run of `task` may spend:
 *  - `undefined`: the task has no ceiling of its own (config decides);
 *  - a positive number: its ceiling less what earlier attempts spent;
 *  - `"exhausted"`: earlier attempts already used it up, so running
 *    again would only spend more. (Passing `0` instead would mean "no
 *    cap" to the loop.)
 */
export function remainingCostUsd(
  task: Pick<TaskRecord, "maxCostUsd" | "spentUsd">,
): number | undefined | "exhausted" {
  if (task.maxCostUsd === null) return undefined;
  const left = task.maxCostUsd - (task.spentUsd ?? 0);
  return left > 0 ? left : "exhausted";
}

/**
 * How long the next run of `task` may take, by the same rules as
 * `remainingCostUsd`: earlier runs count, a resume after a restart
 * included, so a run cut off at hour 7 of 8 gets one hour.
 */
export function remainingDurationMs(
  task: Pick<TaskRecord, "maxDurationMs" | "elapsedMs">,
): number | undefined | "exhausted" {
  if (task.maxDurationMs === null) return undefined;
  const left = task.maxDurationMs - (task.elapsedMs ?? 0);
  return left > 0 ? left : "exhausted";
}

/** A run time for a task's error line. */
export function formatRunTime(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 6) / 10} h`;
}
