import type { PairedDevice } from "../http/device-store.js";

/**
 * ATO-2758: `atag pair --list` dates for people, not ISO stamps: the
 * local date and time plus how long ago ("27 Nov 2026, 10:00 (3 days
 * ago)"), like `gh` and `docker ps` print ages. A stamp that does not
 * parse is printed as it is.
 */

export interface DateFormatOptions {
  /** Defaults to this computer's locale and time zone. */
  locale?: string;
  timeZone?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago"; `null` past 30 days or in the future. */
export function timeAgo(at: Date, now: Date): string | null {
  const delta = now.getTime() - at.getTime();
  if (delta < -MINUTE) return null;
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return plural(Math.floor(delta / MINUTE), "minute");
  if (delta < DAY) return plural(Math.floor(delta / HOUR), "hour");
  if (delta < 30 * DAY) return plural(Math.floor(delta / DAY), "day");
  return null;
}

export function humanDate(iso: string, now: Date, options: DateFormatOptions = {}): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const local = new Intl.DateTimeFormat(options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(at);
  const ago = timeAgo(at, now);
  return ago ? `${local} (${ago})` : local;
}

/** One `--list` line: id, name, when paired, last seen (the age alone when it is recent). */
export function formatDeviceLine(
  device: Pick<PairedDevice, "id" | "name" | "createdAt" | "lastSeenAt">,
  now: Date,
  options: DateFormatOptions = {},
): string {
  const seen = new Date(device.lastSeenAt);
  const seenAgo = Number.isNaN(seen.getTime()) ? null : timeAgo(seen, now);
  const lastSeen = seenAgo && seen.getTime() > now.getTime() - DAY ? seenAgo : humanDate(device.lastSeenAt, now, options);
  return `${device.id}  ${device.name.padEnd(16)} paired ${humanDate(device.createdAt, now, options)}, last seen ${lastSeen}`;
}
