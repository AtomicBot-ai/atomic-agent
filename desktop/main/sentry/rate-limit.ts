/**
 * Send-side limiter for the desktop shell's Sentry events (ATO-1286).
 *
 * A copy of `src/error-reporting/sentry-rate-limit.ts` (the desktop build
 * cannot import from `src/`; keep the two in step), except for the key:
 * see {@link sentryGroupingKey}. At most
 * {@link SENTRY_RATE_LIMIT_MAX_EVENTS} events with the same grouping key
 * are sent per install in any rolling {@link SENTRY_RATE_LIMIT_WINDOW_MS};
 * the rest are dropped before an envelope is built. This sits on top of
 * the per-session caps in `client.ts`: those reset on every launch, this
 * one is kept in a small JSON file in the state dir so a launch loop does
 * not get a fresh budget each time. The file holds only key hashes and
 * timestamps and is written only when an event is actually sent. Every
 * file operation is best-effort.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** At most this many identical events per install per window. */
export const SENTRY_RATE_LIMIT_MAX_EVENTS = 10;
/** The rolling window: one hour. */
export const SENTRY_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
/** Cap on distinct keys kept in the file, so it cannot grow without bound. */
export const SENTRY_RATE_LIMIT_MAX_KEYS = 500;
/** File name in the state dir. */
export const SENTRY_RATE_LIMIT_FILE = "sentry-rate-limit-desktop.json";

/**
 * Reduce a message to its shape: the parts that differ between two
 * copies of the same failure (ports, numbers, paths, URLs, ids) become
 * placeholders, so `connect ECONNREFUSED 127.0.0.1:8093` and
 * `connect ECONNREFUSED 127.0.0.1:19091` share one key.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "<id>",
    )
    .replace(/(?:[a-z]:)?(?:[\\/][^\s\\/'"`:]+){2,}[\\/]?/gi, "<path>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<n>")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\d+(?:\.\d+)*/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * The key two events must share to count as "identical": the envelope's
 * `fingerprint` (`fingerprintOf`) plus the error's normalized message.
 *
 * The fingerprint alone is too coarse here: it is type + source + kind +
 * reason + top frame file name, so every `TypeError` thrown anywhere in
 * `renderer.js` would share one budget and one noisy bug would silence
 * the rest. The message tells them apart; normalizing it keeps two copies
 * of one failure together. Only the key's hash reaches the state file, and
 * the message never goes into the fingerprint Sentry groups on.
 */
export function sentryGroupingKey(fingerprint: readonly string[], message?: unknown): string {
  const text = typeof message === "string" ? normalizeMessage(message) : "";
  return [...fingerprint, text].join("\u0001");
}

/**
 * Short, stable, dependency-free hash (cyrb53) so the file stores a
 * fixed-size token instead of the key's text.
 */
export function hashKey(key: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i += 1) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export interface SentryRateLimiterOptions {
  maxEvents?: number;
  windowMs?: number;
  /** Clock seam; defaults to `Date.now`. */
  now?: () => number;
  /** JSON file to share the counter across restarts; omit for memory only. */
  storePath?: string;
}

type Counts = Map<string, number[]>;

/**
 * Per-install sliding-window counter. {@link shouldSend} both checks and
 * records: it returns `true` (and counts the send) while the key is
 * under its budget, `false` once the window already holds `maxEvents`
 * sends of that key.
 */
export class SentryRateLimiter {
  private readonly maxEvents: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly storePath: string | undefined;
  private counts: Counts | undefined;

  constructor(options: SentryRateLimiterOptions = {}) {
    this.maxEvents = options.maxEvents ?? SENTRY_RATE_LIMIT_MAX_EVENTS;
    this.windowMs = options.windowMs ?? SENTRY_RATE_LIMIT_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.storePath = options.storePath;
  }

  shouldSend(key: string): boolean {
    const now = this.now();
    // Loaded lazily: a session with no errors never touches the file.
    const counts = (this.counts ??= this.load(now));
    const id = hashKey(key);
    const recent = prune(counts.get(id), now, this.windowMs);
    if (recent.length >= this.maxEvents) {
      counts.set(id, recent);
      return false;
    }
    recent.push(now);
    counts.set(id, recent);
    this.persist(now);
    return true;
  }

  private load(now: number): Counts {
    const counts: Counts = new Map();
    if (!this.storePath) return counts;
    mergeInto(counts, readStore(this.storePath), now, this.windowMs);
    return counts;
  }

  private persist(now: number): void {
    if (!this.storePath || !this.counts) return;
    try {
      // A second desktop instance on the same state dir may have counted
      // sends since this one loaded the file; merge them in so neither
      // overwrites the other's budget.
      mergeInto(this.counts, readStore(this.storePath), now, this.windowMs);
      trimKeys(this.counts, SENTRY_RATE_LIMIT_MAX_KEYS);
      const keys: Record<string, number[]> = {};
      for (const [id, stamps] of this.counts) {
        if (stamps.length > 0) keys[id] = stamps.slice(-this.maxEvents);
      }
      mkdirSync(dirname(this.storePath), { recursive: true });
      const tmp = `${this.storePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, keys }), "utf8");
      renameSync(tmp, this.storePath);
    } catch {
      // Best-effort: the in-memory counter still applies.
    }
  }
}

/** Timestamps of `stamps` still inside the window, oldest first. */
function prune(
  stamps: readonly number[] | undefined,
  now: number,
  windowMs: number,
): number[] {
  if (!stamps) return [];
  return stamps.filter((t) => t > now - windowMs && t <= now);
}

function readStore(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object") {
      const keys = (parsed as { keys?: unknown }).keys;
      if (keys && typeof keys === "object") return keys as Record<string, unknown>;
    }
  } catch {
    // Missing or corrupt file: start empty.
  }
  return {};
}

/**
 * Merge `disk` into `counts`, dropping expired stamps. Each timestamp
 * keeps the larger of its two multiplicities rather than their sum: the
 * file already holds this process's own earlier writes, and several
 * sends inside one millisecond are real sends, not duplicates.
 */
function mergeInto(
  counts: Counts,
  disk: Record<string, unknown>,
  now: number,
  windowMs: number,
): void {
  for (const [id, value] of Object.entries(disk)) {
    if (!Array.isArray(value)) continue;
    const fromDisk = value.filter(
      (t): t is number => typeof t === "number" && Number.isFinite(t),
    );
    const mine = tally(counts.get(id) ?? []);
    for (const [t, n] of tally(fromDisk)) {
      mine.set(t, Math.max(mine.get(t) ?? 0, n));
    }
    const merged: number[] = [];
    for (const [t, n] of mine) {
      for (let i = 0; i < n; i += 1) merged.push(t);
    }
    counts.set(id, prune(merged, now, windowMs).sort((a, b) => a - b));
  }
  for (const [id, stamps] of counts) {
    const live = prune(stamps, now, windowMs);
    if (live.length === 0) counts.delete(id);
    else counts.set(id, live);
  }
}

function tally(stamps: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const t of stamps) out.set(t, (out.get(t) ?? 0) + 1);
  return out;
}

/** Keep only the `max` keys with the most recent sends. */
function trimKeys(counts: Counts, max: number): void {
  if (counts.size <= max) return;
  const byRecency = [...counts.entries()].sort(
    (a, b) => (b[1].at(-1) ?? 0) - (a[1].at(-1) ?? 0),
  );
  for (const [id] of byRecency.slice(max)) counts.delete(id);
}
