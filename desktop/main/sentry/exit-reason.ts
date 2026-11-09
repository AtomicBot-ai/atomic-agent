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

/**
 * ATO-424 / ATO-761: the machine's free memory when the agent exited, as a
 * bucket. Sentry showed Windows exits with 0xC000009A (out of system
 * resources) beside Electron's own processes crashing; this says whether
 * the machine was short of memory at that moment. Null when unknown.
 */
export function freeMemoryBucket(freeBytes: number | null | undefined): "lt_512m" | "lt_1g" | "lt_2g" | "lt_4g" | "gte_4g" | null {
  if (typeof freeBytes !== "number" || !Number.isFinite(freeBytes) || freeBytes < 0) return null;
  const mb = freeBytes / 1_048_576;
  if (mb < 512) return "lt_512m";
  if (mb < 1024) return "lt_1g";
  if (mb < 2048) return "lt_2g";
  if (mb < 4096) return "lt_4g";
  return "gte_4g";
}

/** Windows NTSTATUS codes an exit code may carry, as a word (0xC000009A is 3221225626). Null for any other code. */
export function windowsExitStatus(code: number | null | undefined): "insufficient_resources" | "no_memory" | "stack_overflow" | "killed_from_outside" | "access_violation" | null {
  switch (code) {
    case 0xc000009a: return "insufficient_resources";
    case 0xc0000017: return "no_memory";
    case 0xc00000fd: return "stack_overflow";
    case 0x40010004: return "killed_from_outside";
    case 0xc0000005: return "access_violation";
    default: return null;
  }
}

/**
 * ATO-1111: serve's exit code when its memory guard ended it cleanly
 * (src/cli/serve-memory-guard.ts MEMORY_GUARD_EXIT_CODE; the two must agree).
 */
export const AGENT_MEMORY_GUARD_EXIT_CODE = 86;

/**
 * The agent's exit code as one readable word for the `exit_status` tag: a
 * Windows NTSTATUS (windowsExitStatus) or the memory guard's own clean exit.
 * Null for any other code.
 */
export function agentExitStatus(code: number | null | undefined): ReturnType<typeof windowsExitStatus> | "memory_guard" {
  if (code === AGENT_MEMORY_GUARD_EXIT_CODE) return "memory_guard";
  return windowsExitStatus(code);
}

/** The agent's last sampled resident memory, as a bucket (never the figure). Null when unknown. */
export function agentRssBucket(rssMb: number | null | undefined): "lt_512m" | "lt_1g" | "lt_2g" | "lt_4g" | "lt_8g" | "gte_8g" | null {
  if (typeof rssMb !== "number" || !Number.isFinite(rssMb) || rssMb < 0) return null;
  if (rssMb < 512) return "lt_512m";
  if (rssMb < 1024) return "lt_1g";
  if (rssMb < 2048) return "lt_2g";
  if (rssMb < 4096) return "lt_4g";
  if (rssMb < 8192) return "lt_8g";
  return "gte_8g";
}

/**
 * A share (part of whole) as a bucket: the agent's heap of its V8 ceiling,
 * or its RSS of the machine's memory. With agentRssBucket this tells a
 * growing agent (high heap share, big RSS) from a machine that is simply
 * small (modest RSS, high share of a small total). Null when unknown.
 */
export function shareBucket(part: number | null | undefined, whole: number | null | undefined): "lt_25" | "lt_50" | "lt_75" | "lt_90" | "gte_90" | null {
  if (typeof part !== "number" || typeof whole !== "number" || !Number.isFinite(part) || !Number.isFinite(whole) || part < 0 || whole <= 0) return null;
  const pct = (part / whole) * 100;
  if (pct < 25) return "lt_25";
  if (pct < 50) return "lt_50";
  if (pct < 75) return "lt_75";
  if (pct < 90) return "lt_90";
  return "gte_90";
}
