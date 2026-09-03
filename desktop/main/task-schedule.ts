import { CronExpressionParser } from "cron-parser";

/**
 * Port of the agent's schedule helpers for the Tasks tab's create form:
 * `validateSchedule` and `peekNextFirings` from src/tasks/task-schedule.ts
 * and `validateCreateForm` from src/tui/tasks/tasks-form-validator.ts.
 * The bounds, messages and the parser are the agent's own, so the
 * preview the desktop shows is the preview the TUI shows. Nothing here
 * touches the store — `atag task create` does the write.
 */

export type TaskSchedule =
  | { kind: "at"; at: number }
  | { kind: "interval"; everyMs: number }
  | { kind: "cron"; expression: string; tz?: string };

export interface TaskCreateFormInput {
  kind: "cron" | "interval" | "at";
  cronExpression: string;
  intervalSeconds: string;
  atIsoOrMs: string;
  tz: string;
  message: string;
}

export interface TaskCreatePreview {
  ok: boolean;
  error: string | null;
  nextFirings: number[];
}

export interface TaskFormValidation {
  schedule: TaskSchedule | null;
  preview: TaskCreatePreview;
  message: string;
}

/** Lower bound on `interval.everyMs`. Guards against runaway ticks. */
const SCHEDULE_INTERVAL_MIN_MS = 1_000;
/** Upper bound on `at.at` — 10 years from `fromMs`. */
const SCHEDULE_AT_MAX_AHEAD_MS = 10 * 365 * 24 * 60 * 60 * 1_000;
/** Hard cap on `cron.expression` length — keeps the SQLite payload small. */
const SCHEDULE_CRON_MAX_LENGTH = 200;
/** src/tasks/task-types.ts */
const TASK_USER_MESSAGE_MAX_LENGTH = 16_000;

class TaskValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = "TaskValidationError";
  }
}

export function validateSchedule(schedule: TaskSchedule, fromMs: number): void {
  if (!schedule || typeof schedule !== "object") {
    throw new TaskValidationError("schedule", "schedule must be an object");
  }
  if (schedule.kind === "at") {
    if (typeof schedule.at !== "number" || !Number.isFinite(schedule.at)) {
      throw new TaskValidationError("schedule", "schedule.at must be a finite number (Unix ms)");
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
      throw new TaskValidationError("schedule", "schedule.everyMs must be a finite integer");
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
      throw new TaskValidationError("schedule", "schedule.expression must be a non-empty string");
    }
    if (schedule.expression.length > SCHEDULE_CRON_MAX_LENGTH) {
      throw new TaskValidationError(
        "schedule",
        `schedule.expression must be <= ${SCHEDULE_CRON_MAX_LENGTH} chars`,
      );
    }
    if (schedule.tz !== undefined && typeof schedule.tz !== "string") {
      throw new TaskValidationError("schedule", "schedule.tz must be a string or omitted");
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

export function peekNextFirings(schedule: TaskSchedule, fromMs: number, count = 5): number[] {
  if (count <= 0) return [];
  try {
    validateSchedule(schedule, fromMs);
  } catch {
    return [];
  }
  if (schedule.kind === "at") return [schedule.at];
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
    for (let i = 0; i < count; i += 1) firings.push(iter.next().toDate().getTime());
    return firings;
  } catch {
    return [];
  }
}

/** The TUI's create-form validator: schedule + a five-firing preview. */
export function validateCreateForm(form: TaskCreateFormInput, now: number): TaskFormValidation {
  const message = (form.message ?? "").trim();
  if (message.length === 0) return failure("user message must not be empty");
  if (message.length > TASK_USER_MESSAGE_MAX_LENGTH) {
    return failure(`user message must be <= ${TASK_USER_MESSAGE_MAX_LENGTH} chars`, message);
  }
  const scheduleResult = parseSchedule(form, now);
  if (scheduleResult.error !== null) {
    return {
      schedule: null,
      preview: { ok: false, error: scheduleResult.error, nextFirings: [] },
      message,
    };
  }
  const schedule = scheduleResult.schedule;
  const nextFirings = peekNextFirings(schedule, now, 5);
  return { schedule, preview: { ok: true, error: null, nextFirings }, message };
}

function failure(error: string, message = ""): TaskFormValidation {
  return { schedule: null, preview: { ok: false, error, nextFirings: [] }, message };
}

type ParsedSchedule = { schedule: TaskSchedule; error: null } | { schedule: null; error: string };

function parseSchedule(form: TaskCreateFormInput, now: number): ParsedSchedule {
  if (form.kind === "cron") return parseCron(form, now);
  if (form.kind === "interval") return parseInterval(form, now);
  return parseAt(form, now);
}

function parseCron(form: TaskCreateFormInput, now: number): ParsedSchedule {
  const expression = (form.cronExpression ?? "").trim();
  if (expression.length === 0) return fail("cron expression must not be empty");
  const tz = (form.tz ?? "").trim();
  const schedule: TaskSchedule = tz ? { kind: "cron", expression, tz } : { kind: "cron", expression };
  try {
    validateSchedule(schedule, now);
    return { schedule, error: null };
  } catch (err) {
    return fail(messageOf(err));
  }
}

function parseInterval(form: TaskCreateFormInput, now: number): ParsedSchedule {
  const raw = (form.intervalSeconds ?? "").trim();
  if (raw.length === 0) return fail("interval must be a positive integer number of seconds");
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || `${seconds}` !== raw) {
    return fail("interval must be a positive integer number of seconds");
  }
  const schedule: TaskSchedule = { kind: "interval", everyMs: seconds * 1_000 };
  try {
    validateSchedule(schedule, now);
    return { schedule, error: null };
  } catch (err) {
    return fail(messageOf(err));
  }
}

function parseAt(form: TaskCreateFormInput, now: number): ParsedSchedule {
  const raw = (form.atIsoOrMs ?? "").trim();
  if (raw.length === 0) return fail("enter ISO timestamp or Unix-ms for the firing time");
  const parsed = parseIsoOrMs(raw);
  if (parsed === null) return fail("could not parse timestamp; try `2026-05-01T09:00:00Z` or Unix-ms");
  const schedule: TaskSchedule = { kind: "at", at: parsed };
  try {
    validateSchedule(schedule, now);
    return { schedule, error: null };
  } catch (err) {
    return fail(messageOf(err));
  }
}

function parseIsoOrMs(raw: string): number | null {
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function fail(error: string): ParsedSchedule {
  return { schedule: null, error };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
