import { dayKey, dayKeyOffset, isDayKey, minuteOfDay, type LogbookEntry } from "./logbook-store.js";

/**
 * Reading the logbook back: which day, which part of it, which words.
 * Shared by the `logbook.query` tool and `atomic-agent logbook today|show`,
 * so "what did I do yesterday afternoon" means the same window in both.
 */
export const DAY_PARTS: Readonly<Record<string, readonly [number, number]>> = {
  morning: [0, 12 * 60],
  afternoon: [12 * 60, 18 * 60],
  evening: [18 * 60, 24 * 60],
};

export const DEFAULT_QUERY_LIMIT = 120;
export const MAX_QUERY_LIMIT = 400;

export interface LogbookQuery {
  day: string;
  /** Minutes after local midnight, `[fromMinute, toMinute)`. */
  fromMinute: number;
  toMinute: number;
  contains: string | null;
  limit: number;
}

/** `today` (default), `yesterday`, or a `YYYY-MM-DD` day. */
export function parseDaySpec(spec: unknown, now: Date): string {
  if (spec === undefined || spec === null || spec === "") return dayKey(now);
  if (typeof spec !== "string") throw new Error("`day` is today, yesterday or a date like 2026-11-26");
  const value = spec.trim().toLowerCase();
  if (value === "today") return dayKey(now);
  if (value === "yesterday") return dayKeyOffset(now, -1);
  if (isDayKey(value)) return value;
  throw new Error(`\`day\` "${spec}" is not today, yesterday or a date like 2026-11-26`);
}

/** `HH:MM` (24-hour) into minutes after midnight; `24:00` is the end of the day. */
export function parseClock(value: unknown, name: string): number {
  if (typeof value !== "string") throw new Error(`\`${name}\` is a time like 14:30`);
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (!match || hours > 24 || minutes > 59 || (hours === 24 && minutes !== 0)) {
    throw new Error(`\`${name}\` "${value}" is not a time like 14:30`);
  }
  return hours * 60 + minutes;
}

/** Tool or CLI arguments into a query. Throws a sentence the model or the person can act on. */
export function buildLogbookQuery(args: Record<string, unknown>, now: Date): LogbookQuery {
  const day = parseDaySpec(args.day, now);
  let fromMinute = 0;
  let toMinute = 24 * 60;
  if (args.part !== undefined && args.part !== null && args.part !== "") {
    const part = typeof args.part === "string" ? DAY_PARTS[args.part.trim().toLowerCase()] : undefined;
    if (!part) throw new Error("`part` is morning, afternoon or evening");
    [fromMinute, toMinute] = part;
  }
  if (args.from !== undefined && args.from !== null && args.from !== "") fromMinute = parseClock(args.from, "from");
  if (args.to !== undefined && args.to !== null && args.to !== "") toMinute = parseClock(args.to, "to");
  if (toMinute <= fromMinute) throw new Error("`to` must be later than `from`");
  const contains = typeof args.contains === "string" && args.contains.trim() ? args.contains.trim().toLowerCase() : null;
  const rawLimit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_QUERY_LIMIT;
  const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, rawLimit));
  return { day, fromMinute, toMinute, contains, limit };
}

/**
 * Entries in the window that match `contains`, in time order. Over the
 * limit, entries are picked at even steps so the whole window stays
 * covered instead of only its start.
 */
export function selectLogbookEntries(entries: readonly LogbookEntry[], query: LogbookQuery): LogbookEntry[] {
  const matching = entries
    .filter((entry) => {
      const minute = minuteOfDay(new Date(entry.at));
      if (minute < query.fromMinute || minute >= query.toMinute) return false;
      if (query.contains === null) return true;
      return `${entry.app ?? ""} ${entry.text}`.toLowerCase().includes(query.contains);
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (matching.length <= query.limit) return matching;
  const step = matching.length / query.limit;
  const picked: LogbookEntry[] = [];
  for (let i = 0; i < query.limit; i += 1) picked.push(matching[Math.floor(i * step)]!);
  return picked;
}

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** `14:05  Safari  Reading the pull request for the logbook.` one per line. */
export function formatLogbookEntries(entries: readonly LogbookEntry[]): string {
  return entries
    .map((entry) => `${clock(new Date(entry.at))}  ${entry.app ?? "unknown app"}  ${entry.text}`)
    .join("\n");
}

export function describeWindow(query: LogbookQuery): string {
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const whole = query.fromMinute === 0 && query.toMinute === 24 * 60;
  return whole ? query.day : `${query.day} ${fmt(query.fromMinute)}-${fmt(query.toMinute)}`;
}
