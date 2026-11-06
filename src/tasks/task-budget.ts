import type Database from "better-sqlite3";

import { TaskValidationError, type TaskRecord } from "./task-types.js";

/**
 * Per-task budgets (ATO-1108): a spend ceiling, a wall-clock ceiling and
 * what the task's runs have spent so far, as three nullable `tasks`
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
] as const;

/**
 * Give `tasks` its budget columns. Returns why they are missing (the
 * write lock was not granted, the file is read-only), or `null` when all
 * three are there. Without them the store keeps working, but refuses to
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
