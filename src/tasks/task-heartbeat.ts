import { isQuietAt, parseClock, parseQuietHours, type QuietHours } from "./task-report-quiet-hours.js";

/**
 * Heartbeat (ATO-454): a recurring `interval` task that wakes the agent,
 * has it go through a checklist file, and writes to the user only when
 * there is something new. Pure helpers live here; the runner hooks are
 * in `task-heartbeat-run.ts`, the durable settings in
 * `task-heartbeat-store.ts`.
 *
 * The model says "nothing new" by answering `HEARTBEAT_SENTINEL`; such a
 * run is silent: no Telegram report, no desktop notification.
 */

/** What the model answers when there is nothing to tell the user. */
export const HEARTBEAT_SENTINEL = "NO_REPLY";

/** Floor on the heartbeat interval: a shorter one is raised to it. */
export const HEARTBEAT_MIN_INTERVAL_MS = 5 * 60_000;

/** Interval used when the creator gives none. */
export const HEARTBEAT_DEFAULT_INTERVAL_MS = 30 * 60_000;

/** Checklist file name, looked up in the agent's state dir by default. */
export const HEARTBEAT_CHECKLIST_FILENAME = "HEARTBEAT.md";

/**
 * Most of the checklist that goes into the prompt. The whole prompt has
 * to fit a task message (`TASK_USER_MESSAGE_MAX_LENGTH`, 16 000 chars).
 */
export const HEARTBEAT_CHECKLIST_MAX_CHARS = 12_000;

/** Durable settings of one heartbeat, keyed by its task id. */
export interface HeartbeatConfig {
  taskId: string;
  /** Absolute path of the checklist file, read at every run. */
  checklistPath: string;
  /** Local-time window the heartbeat runs in; `null` runs it around the clock. */
  activeHours: QuietHours | null;
  /** Also show news as a desktop notification (Telegram is the task's own `notify`). */
  osNotify: boolean;
}

/**
 * How the last run of a heartbeat ended, shown by `task heartbeat list`
 * instead of a result: a silent run is "nothing new", not output.
 */
export type HeartbeatOutcome =
  | "nothing_new"
  | "delivered"
  | "outside_active_hours"
  | "no_checklist";

export interface HeartbeatState extends HeartbeatConfig {
  lastOutcome: HeartbeatOutcome | null;
  lastCheckedAt: number | null;
}

/** Raise an interval under `HEARTBEAT_MIN_INTERVAL_MS` to it, and say so. */
export function clampHeartbeatIntervalMs(everyMs: number): {
  everyMs: number;
  clamped: boolean;
} {
  if (!Number.isFinite(everyMs) || everyMs < HEARTBEAT_MIN_INTERVAL_MS) {
    return { everyMs: HEARTBEAT_MIN_INTERVAL_MS, clamped: true };
  }
  return { everyMs: Math.round(everyMs), clamped: false };
}

/**
 * `"08:00-22:00"` → a window; `undefined` → no window (`null`); anything
 * else → `"invalid"`, so a typo is refused at create time rather than
 * silently turning the heartbeat off.
 */
export function parseActiveHours(
  raw: string | undefined,
): QuietHours | null | "invalid" {
  if (raw === undefined) return null;
  return parseQuietHours(raw) ?? "invalid";
}

/**
 * Whether `at` (local time) is inside the active window. A window whose
 * start equals its end is the whole day, not an empty one: the creator
 * asked for the heartbeat, so it never ends up never running.
 */
export function isWithinActiveHours(hours: QuietHours | null, at: Date): boolean {
  if (hours === null) return true;
  if (parseClock(hours.start) === parseClock(hours.end)) return true;
  return isQuietAt(hours, at);
}

/**
 * Whether a reply means "nothing new": empty, the sentinel alone, or
 * text that ends with the sentinel as its own word. Markdown and
 * punctuation around it are ignored, and so is case, so a small local
 * model that writes `**no_reply**.` still stays silent.
 */
export function isHeartbeatSilent(reply: string | null | undefined): boolean {
  if (reply === null || reply === undefined) return true;
  const text = reply
    .trim()
    .replace(/[\s`*_"'.!)\]]+$/u, "")
    .replace(/^[\s`*_"'([]+/u, "");
  if (text.length === 0) return true;
  const upper = text.toUpperCase();
  if (upper === HEARTBEAT_SENTINEL) return true;
  if (!upper.endsWith(HEARTBEAT_SENTINEL)) return false;
  const before = text.charAt(text.length - HEARTBEAT_SENTINEL.length - 1);
  return !/[A-Za-z0-9_]/u.test(before);
}

/**
 * What the task row stores as its message: short, so task lists show a
 * readable line. The prompt the model gets is built at run time
 * (`buildHeartbeatPrompt`), with the checklist as it is then.
 */
export function heartbeatTaskMessage(checklistPath: string): string {
  return `Heartbeat check: go through the checklist in ${checklistPath}`;
}

/** The turn's message for one heartbeat run. */
export function buildHeartbeatPrompt(input: {
  checklistPath: string;
  checklist: string;
  at: Date;
}): string {
  const checklist =
    input.checklist.length > HEARTBEAT_CHECKLIST_MAX_CHARS
      ? `${input.checklist.slice(0, HEARTBEAT_CHECKLIST_MAX_CHARS)}\n[checklist cut here]`
      : input.checklist;
  return [
    `This is a scheduled heartbeat check (${input.at.toString()}).`,
    "Go through the checklist below. Use your tools where an item needs checking.",
    "Write to the user only if something on it needs their attention or changed since your last check in this conversation. Do not repeat news you already reported.",
    `If there is nothing new, reply with exactly ${HEARTBEAT_SENTINEL} and nothing else.`,
    "If there is news, reply with a short message for the user; it is delivered to them as it is.",
    "",
    `Checklist (${input.checklistPath}):`,
    checklist.trim(),
  ].join("\n");
}
