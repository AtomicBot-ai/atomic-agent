/**
 * ATO-2526: the pure half of Settings › Logbook and the day timeline
 * (logbook-timeline-ipc.ts, renderer/logbook-settings.js,
 * renderer/logbook-timeline.js). No Electron here, so
 * test/logbook-prefs.test.mjs runs it as built.
 *
 * What the window sends is checked again here before it reaches the
 * runtime (src/http/route-logbook.ts), which checks it a third time.
 */

export interface LogbookSaveBody {
  action?: "start" | "stop";
  intervalMinutes?: number;
  retentionDays?: number;
  excludeApps?: string[];
  titleOnlyApps?: string[];
  standupAt?: string | null;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_APPS = 100;

function intIn(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/** One app per entry, trimmed, no empty ones or repeats, at most 100. */
export function cleanAppList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return null;
    const name = item.trim().slice(0, 200);
    if (name && !out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out.slice(0, MAX_APPS);
}

/** Settings' Save or its on/off switch, as PATCH /api/logbook/settings takes it; a string says what is wrong. */
export function logbookSaveBody(input: unknown): LogbookSaveBody | string {
  if (!input || typeof input !== "object") return "Nothing to save.";
  const o = input as Record<string, unknown>;
  const body: LogbookSaveBody = {};
  if (o.action !== undefined) {
    if (o.action !== "start" && o.action !== "stop") return "That is not a logbook action.";
    body.action = o.action;
  }
  if (o.intervalMinutes !== undefined) {
    const n = intIn(o.intervalMinutes, 1, 60);
    if (n === null) return "A note every 1 to 60 minutes.";
    body.intervalMinutes = n;
  }
  if (o.retentionDays !== undefined) {
    const n = intIn(o.retentionDays, 1, 365);
    if (n === null) return "Notes are kept for 1 to 365 days.";
    body.retentionDays = n;
  }
  for (const key of ["excludeApps", "titleOnlyApps"] as const) {
    if (o[key] === undefined) continue;
    const list = cleanAppList(o[key]);
    if (!list) return "Apps are listed by name, one per line.";
    body[key] = list;
  }
  if (o.standupAt !== undefined) {
    if (o.standupAt !== null && (typeof o.standupAt !== "string" || !CLOCK.test(o.standupAt))) return "The standup time looks like 09:00.";
    body.standupAt = o.standupAt as string | null;
  }
  return Object.keys(body).length ? body : "Nothing to save.";
}

/** `today`, `yesterday` or a date the runtime keeps, else null. */
export function cleanDay(day: unknown): string | null {
  if (day === "today" || day === "yesterday") return day;
  return typeof day === "string" && DAY.test(day) ? day : null;
}

export type LogbookDeleteBody = { day: string; all: true } | { day: string; at: string[] };

/** One note (by its time), several, or the whole day. */
export function logbookDeleteBody(input: unknown): LogbookDeleteBody | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o.day !== "string" || !DAY.test(o.day)) return null;
  if (o.all === true) return { day: o.day, all: true };
  if (!Array.isArray(o.at)) return null;
  const at = o.at.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 40).slice(0, 2_000);
  return at.length ? { day: o.day, at } : null;
}

export interface LogbookTimelineEntry {
  at: string;
  app: string | null;
  text: string;
}

/** GET /api/logbook/day's answer, or null. */
export function parseLogbookDay(raw: unknown): { day: string; entries: LogbookTimelineEntry[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.day !== "string" || !Array.isArray(o.entries)) return null;
  const entries: LogbookTimelineEntry[] = [];
  for (const e of o.entries) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (typeof r.at !== "string" || typeof r.text !== "string") continue;
    entries.push({ at: r.at, app: typeof r.app === "string" ? r.app : null, text: r.text });
  }
  return { day: o.day, entries };
}

/** The person is away: the screen is locked, or no input for the idle time (Electron powerMonitor). */
export function isAway(idleState: string, locked: boolean): boolean {
  return locked || idleState === "idle" || idleState === "locked";
}

/** Seconds without input before the app says "away": the runtime's own minimum idle skip, 5 min. */
export const AWAY_IDLE_SECONDS = 300;
