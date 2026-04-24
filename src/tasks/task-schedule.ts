import { CronExpressionParser } from "cron-parser";

import { TaskValidationError, type TaskSchedule } from "./task-types.js";

/**
 * Schedule-helper primitives: pure functions that translate a
 * `TaskSchedule` into the next `scheduledFor` timestamp, plus a
 * one-liner that tells the runner whether a schedule should be requeued
 * after completion.
 *
 * `cron-parser` is encapsulated here — no other module in the codebase
 * imports it directly so we can swap the parser later without ripple.
 *
 * Validation bounds are enforced up-front with `TaskValidationError`
 * so bad shapes surface at `TaskRunner.create` time (HTTP 400 / CLI
 * exit code 1) rather than inside a silent tick.
 */

/** Lower bound on `interval.everyMs`. Guards against runaway ticks. */
export const SCHEDULE_INTERVAL_MIN_MS = 1_000;

/** Upper bound on `at.at` — 10 years from `fromMs`. */
export const SCHEDULE_AT_MAX_AHEAD_MS = 10 * 365 * 24 * 60 * 60 * 1_000;

/** Hard cap on `cron.expression` length — keeps the SQLite payload small. */
export const SCHEDULE_CRON_MAX_LENGTH = 200;

/**
 * Recurring schedules (`cron`, `interval`) are requeued by
 * `TaskRunner.runOne` on the happy-path completion. One-shot
 * schedules (`at`) and null schedules (immediate) terminate on the
 * first success.
 */
export function isRecurring(schedule: TaskSchedule | null): boolean {
  if (!schedule) return false;
  return schedule.kind === "cron" || schedule.kind === "interval";
}

/**
 * Resolve the next Unix-ms trigger for a schedule, relative to
 * `fromMs`. The caller is responsible for deciding whether this is a
 * first-time resolution (create path) or a requeue (completion path)
 * — both paths go through the same function so the ticker always sees
 * a monotonic `scheduled_for`.
 *
 * Contract:
 *  - `at`:       returns `at` (may be in the past; the scheduler still picks it).
 *  - `cron`:     returns the next firing strictly after `fromMs`.
 *  - `interval`: returns `fromMs + everyMs`.
 *
 * Throws `TaskValidationError("schedule", ...)` on invalid shapes.
 */
export function resolveScheduledFor(
  schedule: TaskSchedule,
  fromMs: number,
): number {
  validateSchedule(schedule, fromMs);
  if (schedule.kind === "at") {
    return schedule.at;
  }
  if (schedule.kind === "interval") {
    return fromMs + schedule.everyMs;
  }
  const options = {
    currentDate: new Date(fromMs),
    ...(schedule.tz ? { tz: schedule.tz } : {}),
  };
  try {
    const iter = CronExpressionParser.parse(schedule.expression, options);
    return iter.next().toDate().getTime();
  } catch (err) {
    throw new TaskValidationError(
      "schedule",
      `invalid cron expression: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Validate a schedule without computing the next tick. Called from
 * `TaskRunner.create` before any SQLite write so bad payloads never
 * land on disk. Reused by `resolveScheduledFor` to keep the error
 * surface consistent.
 */
export function validateSchedule(
  schedule: TaskSchedule,
  fromMs: number,
): void {
  if (!schedule || typeof schedule !== "object") {
    throw new TaskValidationError("schedule", "schedule must be an object");
  }
  if (schedule.kind === "at") {
    if (typeof schedule.at !== "number" || !Number.isFinite(schedule.at)) {
      throw new TaskValidationError(
        "schedule",
        "schedule.at must be a finite number (Unix ms)",
      );
    }
    if (schedule.at - fromMs > SCHEDULE_AT_MAX_AHEAD_MS) {
      throw new TaskValidationError(
        "schedule",
        `schedule.at must be within ${SCHEDULE_AT_MAX_AHEAD_MS} ms of now`,
      );
    }
    return;
  }
  if (schedule.kind === "interval") {
    if (
      typeof schedule.everyMs !== "number" ||
      !Number.isFinite(schedule.everyMs) ||
      !Number.isInteger(schedule.everyMs)
    ) {
      throw new TaskValidationError(
        "schedule",
        "schedule.everyMs must be a finite integer",
      );
    }
    if (schedule.everyMs < SCHEDULE_INTERVAL_MIN_MS) {
      throw new TaskValidationError(
        "schedule",
        `schedule.everyMs must be >= ${SCHEDULE_INTERVAL_MIN_MS}`,
      );
    }
    return;
  }
  if (schedule.kind === "cron") {
    if (typeof schedule.expression !== "string" || schedule.expression.length === 0) {
      throw new TaskValidationError(
        "schedule",
        "schedule.expression must be a non-empty string",
      );
    }
    if (schedule.expression.length > SCHEDULE_CRON_MAX_LENGTH) {
      throw new TaskValidationError(
        "schedule",
        `schedule.expression must be <= ${SCHEDULE_CRON_MAX_LENGTH} chars`,
      );
    }
    if (schedule.tz !== undefined && typeof schedule.tz !== "string") {
      throw new TaskValidationError(
        "schedule",
        "schedule.tz must be a string or omitted",
      );
    }
    try {
      CronExpressionParser.parse(schedule.expression, {
        currentDate: new Date(fromMs),
        ...(schedule.tz ? { tz: schedule.tz } : {}),
      });
    } catch (err) {
      throw new TaskValidationError(
        "schedule",
        `invalid cron expression: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  throw new TaskValidationError(
    "schedule",
    `unknown schedule kind: ${JSON.stringify((schedule as { kind?: unknown }).kind)}`,
  );
}

/**
 * Serialise a schedule to the JSON payload that lives in
 * `tasks.schedule_value`. Mirrors the runtime shape — `kind` is
 * stored in its own column so the JSON body holds only the
 * kind-specific members.
 */
export function serializeScheduleValue(schedule: TaskSchedule): string {
  if (schedule.kind === "at") return JSON.stringify({ at: schedule.at });
  if (schedule.kind === "interval")
    return JSON.stringify({ everyMs: schedule.everyMs });
  return JSON.stringify({
    expression: schedule.expression,
    ...(schedule.tz ? { tz: schedule.tz } : {}),
  });
}

/**
 * Preview the next `count` firings for a schedule without committing
 * anything to the store. Used by the TUI create form to render a
 * "next 5 firings" block so the user can sanity-check a cron expression
 * before submission. Keeps the `cron-parser` dependency isolated inside
 * this module.
 *
 * Returns a truncated list on validation failure (empty when the
 * schedule is invalid) — the caller is expected to check validity via
 * `validateSchedule` separately.
 */
export function peekNextFirings(
  schedule: TaskSchedule,
  fromMs: number,
  count = 5,
): readonly number[] {
  if (count <= 0) return [];
  try {
    validateSchedule(schedule, fromMs);
  } catch {
    return [];
  }
  if (schedule.kind === "at") {
    return [schedule.at];
  }
  if (schedule.kind === "interval") {
    const firings: number[] = [];
    let cursor = fromMs;
    for (let i = 0; i < count; i += 1) {
      cursor = cursor + schedule.everyMs;
      firings.push(cursor);
    }
    return firings;
  }
  const options = {
    currentDate: new Date(fromMs),
    ...(schedule.tz ? { tz: schedule.tz } : {}),
  };
  try {
    const iter = CronExpressionParser.parse(schedule.expression, options);
    const firings: number[] = [];
    for (let i = 0; i < count; i += 1) {
      firings.push(iter.next().toDate().getTime());
    }
    return firings;
  } catch {
    return [];
  }
}

/**
 * Inverse of `serializeScheduleValue`. Takes the `kind` from its own
 * column and the JSON body from `schedule_value` and reconstructs the
 * structured `TaskSchedule`.
 */
export function parseScheduleRow(
  kind: string | null,
  value: string | null,
): TaskSchedule | null {
  if (!kind || !value) return null;
  const body = JSON.parse(value) as Record<string, unknown>;
  if (kind === "at") {
    return { kind: "at", at: Number(body.at) };
  }
  if (kind === "interval") {
    return { kind: "interval", everyMs: Number(body.everyMs) };
  }
  if (kind === "cron") {
    return {
      kind: "cron",
      expression: String(body.expression),
      ...(typeof body.tz === "string" ? { tz: body.tz } : {}),
    };
  }
  return null;
}
