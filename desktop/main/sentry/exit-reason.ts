/**
 * ATO-763 — why the agent exited, as tags with no text in them.
 *
 * The agent's exit code is almost always 1, so an AgentExited report could
 * not tell running out of memory from a busy port or a broken database. Its
 * last error lines are in main (main.ts AGENT_SAID), but they can hold the
 * person's own words, so they never go into a report. This reads them and
 * answers ONE word from a closed list; the lines stay here.
 *
 * Pure: no Electron, no fs. The unit test drives it on made-up lines.
 */

export const LAST_ERROR_CATEGORIES = [
  "oom", "port_in_use", "econnrefused", "sqlite", "telegram_conflict", "permission", "missing_file", "none", "other",
] as const;
export type LastErrorCategory = (typeof LAST_ERROR_CATEGORIES)[number];

/** How many of the newest lines are read: the agent's last words, not the whole session. */
export const LAST_LINES = 12;

/** One line's category, or null when it names none of them. Order matters: the more telling cause first. */
function categoryOf(line: string): Exclude<LastErrorCategory, "none" | "other"> | null {
  if (/out of memory|ENOMEM|heap limit|allocation failed/i.test(line)) return "oom";
  if (/EADDRINUSE|address already in use/i.test(line)) return "port_in_use";
  if (/terminated by other getUpdates|telegram\b.*\b(409|conflict)\b/i.test(line)) return "telegram_conflict";
  if (/SQLITE_|sqlite|database disk image is malformed|database is locked/i.test(line)) return "sqlite";
  if (/EACCES|EPERM|permission denied|operation not permitted/i.test(line)) return "permission";
  if (/ENOENT|no such file or directory|cannot find module/i.test(line)) return "missing_file";
  if (/ECONNREFUSED/i.test(line)) return "econnrefused";
  return null;
}

/**
 * The category of the agent's last error: the newest of its last LAST_LINES
 * lines that names one; `other` when it said something none of them match;
 * `none` when it said nothing at all (a kill from outside, say).
 */
export function lastErrorCategory(lines: readonly string[]): LastErrorCategory {
  const recent = lines.slice(Math.max(0, lines.length - LAST_LINES)).filter((l) => typeof l === "string" && l.trim());
  if (recent.length === 0) return "none";
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = categoryOf(recent[i]!);
    if (c) return c;
  }
  return "other";
}

/** How long the agent had run, as a bucket (never the figure). Null when unknown. */
export function uptimeBucket(ms: number | null | undefined): "lt_10s" | "lt_1m" | "lt_10m" | "lt_1h" | "gte_1h" | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 10_000) return "lt_10s";
  if (ms < 60_000) return "lt_1m";
  if (ms < 600_000) return "lt_10m";
  if (ms < 3_600_000) return "lt_1h";
  return "gte_1h";
}
