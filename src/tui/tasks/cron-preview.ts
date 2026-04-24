import { peekNextFirings } from "../../tasks/task-schedule.js";
import type { TaskSchedule } from "../../tasks/task-types.js";

/**
 * Thin wrapper around the schedule helper so the TUI layer never
 * touches `cron-parser` directly — keeps the "cron-parser lives behind
 * task-schedule.ts" invariant from Option 4 intact.
 */
export function previewNextFirings(
  schedule: TaskSchedule,
  now: number,
  count = 5,
): readonly number[] {
  return peekNextFirings(schedule, now, count);
}
