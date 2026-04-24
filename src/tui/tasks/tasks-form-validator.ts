import { validateSchedule } from "../../tasks/task-schedule.js";
import {
  TaskValidationError,
  TASK_USER_MESSAGE_MAX_LENGTH,
  type TaskSchedule,
} from "../../tasks/task-types.js";
import type {
  TaskCreateFormState,
  TaskCreatePreview,
} from "./tasks-panel-state.js";
import { previewNextFirings } from "./cron-preview.js";

/**
 * Pure validator for the create form. Produces both the structured
 * `TaskSchedule` that the orchestrator will hand to
 * `TaskRunner.create`, and a render-ready preview block with up to 5
 * upcoming firings. All messages are human-facing — surfaced under the
 * relevant field in the form.
 */
export interface TaskFormValidation {
  /** `null` when validation failed — UI disables the submit button. */
  schedule: TaskSchedule | null;
  preview: TaskCreatePreview;
  /** Message the orchestrator will send — trimmed. */
  message: string;
}

export function validateCreateForm(
  form: TaskCreateFormState,
  now: number,
): TaskFormValidation {
  const message = form.message.trim();
  if (message.length === 0) {
    return failure("user message must not be empty");
  }
  if (message.length > TASK_USER_MESSAGE_MAX_LENGTH) {
    return failure(
      `user message must be <= ${TASK_USER_MESSAGE_MAX_LENGTH} chars`,
      message,
    );
  }
  const scheduleResult = parseSchedule(form, now);
  if (scheduleResult.error !== null) {
    return {
      schedule: null,
      preview: { ok: false, error: scheduleResult.error, nextFirings: [] },
      message,
    };
  }
  const schedule: TaskSchedule = scheduleResult.schedule;
  const nextFirings = previewNextFirings(schedule, now, 5);
  return {
    schedule,
    preview: { ok: true, error: null, nextFirings },
    message,
  };
}

function failure(error: string, message = ""): TaskFormValidation {
  return {
    schedule: null,
    preview: { ok: false, error, nextFirings: [] },
    message,
  };
}

interface ParsedScheduleResult {
  schedule: TaskSchedule;
  error: null;
}
interface FailedScheduleResult {
  schedule: TaskSchedule | null;
  error: string;
}

function parseSchedule(
  form: TaskCreateFormState,
  now: number,
): ParsedScheduleResult | FailedScheduleResult {
  if (form.kind === "cron") {
    return parseCron(form, now);
  }
  if (form.kind === "interval") {
    return parseInterval(form, now);
  }
  return parseAt(form, now);
}

function parseCron(
  form: TaskCreateFormState,
  now: number,
): ParsedScheduleResult | FailedScheduleResult {
  const expression = form.cronExpression.trim();
  if (expression.length === 0) {
    return fail("cron expression must not be empty");
  }
  const tz = form.tz.trim();
  const schedule: TaskSchedule = tz
    ? { kind: "cron", expression, tz }
    : { kind: "cron", expression };
  try {
    validateSchedule(schedule, now);
    return { schedule, error: null };
  } catch (err) {
    return fail(messageOf(err));
  }
}

function parseInterval(
  form: TaskCreateFormState,
  now: number,
): ParsedScheduleResult | FailedScheduleResult {
  const raw = form.intervalSeconds.trim();
  if (raw.length === 0) {
    return fail("interval must be a positive integer number of seconds");
  }
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || `${seconds}` !== raw) {
    return fail("interval must be a positive integer number of seconds");
  }
  const everyMs = seconds * 1_000;
  const schedule: TaskSchedule = { kind: "interval", everyMs };
  try {
    validateSchedule(schedule, now);
    return { schedule, error: null };
  } catch (err) {
    return fail(messageOf(err));
  }
}

function parseAt(
  form: TaskCreateFormState,
  now: number,
): ParsedScheduleResult | FailedScheduleResult {
  const raw = form.atIsoOrMs.trim();
  if (raw.length === 0) {
    return fail("enter ISO timestamp or Unix-ms for the firing time");
  }
  const parsed = parseIsoOrMs(raw);
  if (parsed === null) {
    return fail("could not parse timestamp; try `2026-05-01T09:00:00Z` or Unix-ms");
  }
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

function fail(error: string): FailedScheduleResult {
  return { schedule: null, error };
}

function messageOf(err: unknown): string {
  if (err instanceof TaskValidationError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
