import {
  TASK_USER_MESSAGE_MAX_LENGTH,
  type TaskCreateInput,
  type TaskSchedule,
} from "../../tasks/index.js";
import type { HermesCronJob } from "./hermes-source.js";

/** Outcome of mapping one Hermes cron job. */
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
 * Map a Hermes cron job onto a native `TaskCreateInput`, or skip it with
 * a reason. Schedule field names mirror `cron/jobs.py parse_schedule`:
 * `once{run_at}`, `interval{minutes}`, `cron{expr}`.
 */
export function mapHermesCronJob(
  job: HermesCronJob,
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
  job: HermesCronJob,
  now: number,
): { schedule: TaskSchedule } | { skip: string } {
  const { schedule } = job;
  switch (schedule.kind) {
    case "once": {
      if (!schedule.run_at) {
        return { skip: "one-shot job without run_at" };
      }
      const at = Date.parse(schedule.run_at);
      if (Number.isNaN(at)) {
        return { skip: `unparseable run_at: ${schedule.run_at}` };
      }
      if (at <= now) {
        return { skip: "one-shot scheduled in the past" };
      }
      return { schedule: { kind: "at", at } };
    }
    case "interval": {
      if (typeof schedule.minutes !== "number" || schedule.minutes <= 0) {
        return { skip: "interval job without positive minutes" };
      }
      return {
        schedule: { kind: "interval", everyMs: Math.round(schedule.minutes * 60_000) },
      };
    }
    case "cron": {
      if (!schedule.expr || schedule.expr.trim().length === 0) {
        return { skip: "cron job without expression" };
      }
      return { schedule: { kind: "cron", expression: schedule.expr } };
    }
    default:
      return { skip: `unsupported schedule kind: ${schedule.kind || "(none)"}` };
  }
}
