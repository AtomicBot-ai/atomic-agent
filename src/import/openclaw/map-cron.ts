import {
  TASK_USER_MESSAGE_MAX_LENGTH,
  type TaskCreateInput,
  type TaskSchedule,
} from "../../tasks/index.js";
import type { OpenclawCronJob } from "./openclaw-source.js";

/** Outcome of mapping one OpenClaw cron job. */
export type MapCronResult =
  | { kind: "task"; input: TaskCreateInput }
  | { kind: "skip"; reason: string };

export interface MapCronOptions {
  /** Retry budget applied to the created task. */
  maxAttempts: number;
  /** Injectable clock for deterministic past-detection in tests. */
  now?: number;
}

/**
 * Map an OpenClaw cron job onto a native `TaskCreateInput`, or skip it
 * with a reason. The schedule kind is resolved **field-driven** — by
 * whichever of `scheduleExpr` / `everyMs` / `at` is populated — rather
 * than trusting `scheduleKind`, because the on-disk `schedule_kind` enum
 * strings are not stable across OpenClaw versions. The string is used
 * only in skip reasons for diagnostics.
 */
export function mapOpenclawCronJob(
  job: OpenclawCronJob,
  options: MapCronOptions,
): MapCronResult {
  if (!job.enabled) {
    return { kind: "skip", reason: "disabled" };
  }
  const prompt = job.prompt.trim();
  if (prompt.length === 0) {
    return { kind: "skip", reason: "empty prompt" };
  }

  const now = options.now ?? Date.now();
  const scheduleResult = resolveSchedule(job, now);
  if ("skip" in scheduleResult) {
    return { kind: "skip", reason: scheduleResult.skip };
  }

  const userMessage = prompt.slice(0, TASK_USER_MESSAGE_MAX_LENGTH);
  return {
    kind: "task",
    input: {
      sessionId: null,
      userMessage,
      origin: "cli",
      triggerSource: "user",
      maxAttempts: options.maxAttempts,
      schedule: scheduleResult.schedule,
    },
  };
}

function resolveSchedule(
  job: OpenclawCronJob,
  now: number,
): { schedule: TaskSchedule } | { skip: string } {
  if (job.scheduleExpr && job.scheduleExpr.trim().length > 0) {
    const tz = job.scheduleTz?.trim();
    return {
      schedule: {
        kind: "cron",
        expression: job.scheduleExpr.trim(),
        ...(tz ? { tz } : {}),
      },
    };
  }
  if (typeof job.everyMs === "number" && job.everyMs > 0) {
    return { schedule: { kind: "interval", everyMs: Math.round(job.everyMs) } };
  }
  if (job.at && job.at.trim().length > 0) {
    const at = Date.parse(job.at);
    if (Number.isNaN(at)) {
      return { skip: `unparseable at: ${job.at}` };
    }
    if (at <= now) {
      return { skip: "one-shot scheduled in the past" };
    }
    return { schedule: { kind: "at", at } };
  }
  return {
    skip: `unsupported schedule (kind: ${job.scheduleKind || "(none)"})`,
  };
}
