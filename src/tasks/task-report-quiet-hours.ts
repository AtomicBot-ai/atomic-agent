/**
 * Quiet hours for task reports: a local-time window (`23:00`–`08:00`)
 * during which a finished task's report is held and then sent, merged
 * with the others, when the window ends. Pure time math, local clock;
 * the window may wrap midnight. `start === end` is an empty window
 * (never quiet), not a 24-hour one.
 */
export interface QuietHours {
  /** `HH:MM`, 24-hour, local time. */
  start: string;
  /** `HH:MM`, 24-hour, local time. Held reports are sent at this time. */
  end: string;
}

const HH_MM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Minutes after local midnight, or `null` for a malformed `HH:MM`. */
export function parseClock(value: string): number | null {
  const m = HH_MM.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * `"23:00-08:00"` → `{ start, end }`; `null` for anything else, so a
 * typo turns the feature off instead of holding reports forever.
 */
export function parseQuietHours(raw: string | undefined): QuietHours | null {
  if (raw === undefined) return null;
  const parts = raw.split("-").map((p) => p.trim());
  if (parts.length !== 2) return null;
  const [start, end] = parts as [string, string];
  if (parseClock(start) === null || parseClock(end) === null) return null;
  return { start, end };
}

export function isQuietAt(hours: QuietHours, at: Date): boolean {
  const start = parseClock(hours.start);
  const end = parseClock(hours.end);
  if (start === null || end === null || start === end) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * The next moment the window ends, strictly after `at`, local time.
 * Built with calendar fields (not `+ 24h`) so a DST change between now
 * and the release does not shift it by an hour.
 */
export function nextQuietEnd(hours: QuietHours, at: Date): Date {
  const end = parseClock(hours.end) ?? 0;
  const candidate = new Date(
    at.getFullYear(),
    at.getMonth(),
    at.getDate(),
    Math.floor(end / 60),
    end % 60,
    0,
    0,
  );
  if (candidate.getTime() <= at.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}
