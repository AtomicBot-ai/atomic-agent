import type { TaskRecord, TaskSchedule } from "../../tasks/task-types.js";
import type { TaskSummaryRow } from "./tasks-panel-state.js";

/** Hard cap on the `userMessage` preview rendered in the list view. */
export const TASK_SUMMARY_MESSAGE_MAX_CHARS = 96;

/**
 * Compact `TaskRecord` to `TaskSummaryRow`. Strips long message bodies
 * to a single collapsed line (whitespace-normalised) and produces a
 * short human-readable `scheduleLabel` so the table stays one row per
 * task under realistic terminal widths.
 */
export function toTaskSummaryRow(record: TaskRecord): TaskSummaryRow {
  return {
    id: record.id,
    status: record.status,
    origin: record.origin,
    triggerSource: record.triggerSource,
    sessionId: record.sessionId,
    userMessage: condenseMessage(record.userMessage),
    scheduleKind: record.schedule?.kind ?? null,
    scheduleLabel: formatScheduleLabel(record.schedule),
    recurring: record.recurring,
    scheduledFor: record.scheduledFor,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    lastError: record.lastError,
  };
}

/** Convenience for the orchestrator — maps a snapshot list in one go. */
export function toTaskSummaryRows(
  records: readonly TaskRecord[],
): TaskSummaryRow[] {
  return records.map(toTaskSummaryRow);
}

/**
 * Normalise whitespace, trim, and truncate with an ellipsis so long
 * multi-line prompts never wrap the table.
 */
function condenseMessage(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length <= TASK_SUMMARY_MESSAGE_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, TASK_SUMMARY_MESSAGE_MAX_CHARS - 1)}…`;
}

/**
 * Render a compact "cron: 0 * * * *" / "every 5m" / "at: <iso>" label.
 * Returns "-" when the task has no schedule (eager one-shot).
 */
export function formatScheduleLabel(schedule: TaskSchedule | null): string {
  if (!schedule) return "-";
  if (schedule.kind === "at") {
    return `at ${formatUnixMs(schedule.at)}`;
  }
  if (schedule.kind === "cron") {
    const tz = schedule.tz ? ` (${schedule.tz})` : "";
    return `cron: ${schedule.expression}${tz}`;
  }
  return `every ${formatIntervalMs(schedule.everyMs)}`;
}

/**
 * Format a Unix-ms timestamp as a short local ISO-like string. We drop
 * the seconds fraction and the trailing `Z` for density.
 */
export function formatUnixMs(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "-";
  const pad = (n: number): string => String(n).padStart(2, "0");
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return `${y}-${mo}-${da} ${hh}:${mm}`;
}

/** Human-compact duration: `10s`, `5m`, `2h`, `1d`. */
export function formatIntervalMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return `${ms}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

/**
 * "in 2m" / "3s ago" — used for the `next-run` column.
 * `null` renders as `-`.
 */
export function formatRelativeMs(
  target: number | null,
  now: number,
): string {
  if (target === null) return "-";
  const deltaMs = target - now;
  const abs = Math.abs(deltaMs);
  if (abs < 1_000) return "now";
  const suffix = deltaMs >= 0 ? "in " : "";
  const prefix = deltaMs >= 0 ? "" : " ago";
  return `${suffix}${formatIntervalMs(abs)}${prefix}`;
}
