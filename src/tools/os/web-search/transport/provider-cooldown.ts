import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { WebSearchProviderName } from "../web-search-provider.js";

/**
 * Which providers are parked, and until when.
 *
 * The transport already retries a 429 twice against the same provider
 * before the orchestrator advances the chain, which is the right
 * behaviour for a *burst*. Issue #179 measured what happens when the
 * limit is not a burst: 1341 `Exa returned HTTP 429` errors in one
 * campaign — 44% of all tool failures — spread evenly across all
 * twenty-four hours, 8 to 20 an hour, not tracking concurrency at all.
 * That is a standing quota on the keyless tier.
 *
 * Against a standing quota the retry ladder is worse than useless. Every
 * search re-enters it from the top: three requests that cannot succeed,
 * ~1.5s of backoff slept through, and only then the fallback that was
 * always going to serve the query. Multiply by a search-heavy run.
 *
 * So a provider that is out of quota gets parked. The next search skips
 * it outright — no request, no sleep — and goes straight to the
 * provider that can actually answer. When the park expires it is tried
 * again, and one success clears the record.
 *
 * **Per-runtime by default, persisted on request (#256).** Not a global
 * singleton: the tool owns one instance in its closure. The in-memory
 * variant dies with the process — right for a long-lived session, but a
 * campaign that runs one process per task then pays a fresh 429 at every
 * start to rediscover a quota the last process hit minutes ago.
 * `createPersistentProviderCooldown` writes the same entries through to
 * disk so the next process inherits them. A quota window is still a fact
 * about the last few minutes: a park that lapsed while nothing ran reads
 * as expired, and a record whose park ended more than `2 * maxMs` ago is
 * dropped on load rather than parking a provider on yesterday's evidence.
 */
export interface ProviderCooldown {
  /** True while `name` is parked — the orchestrator skips it. */
  isParked(name: WebSearchProviderName, now: number): boolean;
  /** Milliseconds left on the park, or `0` when it is not parked. */
  remainingMs(name: WebSearchProviderName, now: number): number;
  /**
   * Record a rate limit and park the provider. Returns the park length
   * actually applied, so the caller can say it out loud.
   */
  park(
    name: WebSearchProviderName,
    now: number,
    retryAfterMs: number | null,
  ): number;
  /** A provider answered. Forget its history so the next park starts small. */
  clear(name: WebSearchProviderName): void;
}

export interface ProviderCooldownOptions {
  /** First park after a single 429. */
  baseMs?: number;
  /** Ceiling on the doubling. */
  maxMs?: number;
}

export interface PersistentProviderCooldownOptions extends ProviderCooldownOptions {
  /** Absolute path of the JSON file mirroring the cooldown on disk. */
  filePath: string;
  /**
   * Injectable clock for the load-time age-out. The live methods keep
   * taking `now` per call, exactly as the in-memory variant does.
   */
  now?: () => number;
}

/**
 * One minute, then two, then four… A single 429 is often a burst that
 * the transport's retries did not quite outlast, and parking such a
 * provider for a quarter of an hour would be its own kind of silent
 * degradation. Repeated 429s are the signal that the limit is standing,
 * and that is what the doubling is listening for.
 */
const DEFAULT_BASE_MS = 60_000;

/**
 * Fifteen minutes. Long enough that a search-heavy run stops paying the
 * failed-request tax, short enough that a quota which resets hourly is
 * noticed within the same session.
 */
const DEFAULT_MAX_MS = 15 * 60_000;

/**
 * A `Retry-After` this long is not advice about the next few seconds,
 * it is a lockout — and honouring it verbatim would park the provider
 * past the end of most sessions on one header. Clamped to the same
 * ceiling the doubling respects.
 */
const MAX_HONOURED_RETRY_AFTER_MS = DEFAULT_MAX_MS;

interface CooldownEntry {
  until: number;
  /** Consecutive parks, for the doubling. */
  strikes: number;
}

export function createProviderCooldown(
  options: ProviderCooldownOptions = {},
): ProviderCooldown {
  return buildCooldown(options, new Map<WebSearchProviderName, CooldownEntry>(), undefined);
}

/**
 * The same cooldown, mirrored to a JSON file so a new process inherits
 * parks and strikes instead of paying a 429 to relearn them (#256).
 * Park/escalation semantics are exactly those of `createProviderCooldown`;
 * only the storage changes. Entries are loaded on creation (records whose
 * park ended more than `2 * maxMs` ago are dropped as stale evidence) and
 * written through on every `park`/`clear` via tmp-file + rename. A missing
 * or corrupt file starts cold; a failed write is swallowed. Concurrent
 * processes race benignly: last writer wins.
 */
export function createPersistentProviderCooldown(
  options: PersistentProviderCooldownOptions,
): ProviderCooldown {
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const now = options.now ?? Date.now;
  const entries = loadCooldownFile(options.filePath, now(), maxMs);
  return buildCooldown(options, entries, () =>
    saveCooldownFile(options.filePath, entries),
  );
}

function buildCooldown(
  options: ProviderCooldownOptions,
  entries: Map<WebSearchProviderName, CooldownEntry>,
  persist: (() => void) | undefined,
): ProviderCooldown {
  const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;

  function remainingMs(name: WebSearchProviderName, now: number): number {
    const entry = entries.get(name);
    if (!entry) return 0;
    return Math.max(0, entry.until - now);
  }

  return {
    remainingMs,
    isParked(name, now) {
      return remainingMs(name, now) > 0;
    },
    park(name, now, retryAfterMs) {
      const previous = entries.get(name);
      // Strikes survive an expired park on purpose: a provider that has
      // been rate-limited three times in the last ten minutes has a
      // standing quota whether or not its last park has lapsed, and
      // restarting the ladder at one minute each time would walk it
      // back into the same wall. `clear` is what resets this, and only
      // a successful search calls `clear`.
      const strikes = (previous?.strikes ?? 0) + 1;
      const escalated = Math.min(maxMs, baseMs * 2 ** (strikes - 1));
      // The server's own number wins when it gave one — it is the only
      // party that knows when the window actually resets — but never
      // below the escalated floor, or a provider answering
      // `Retry-After: 1` on every request would defeat the ladder by
      // being polite about it.
      const advertised =
        retryAfterMs === null
          ? 0
          : Math.min(MAX_HONOURED_RETRY_AFTER_MS, Math.max(0, retryAfterMs));
      const parkMs = Math.max(escalated, advertised);
      entries.set(name, { until: now + parkMs, strikes });
      persist?.();
      return parkMs;
    },
    clear(name) {
      if (entries.delete(name)) persist?.();
    },
  };
}

function loadCooldownFile(
  filePath: string,
  now: number,
  maxMs: number,
): Map<WebSearchProviderName, CooldownEntry> {
  const entries = new Map<WebSearchProviderName, CooldownEntry>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    // Missing on the very first run, or corrupt. A cold cooldown is the
    // pre-#256 behaviour, so it is always a safe recovery.
    return entries;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return entries;
  }
  for (const [name, raw] of Object.entries(parsed)) {
    const entry = raw as Partial<CooldownEntry> | null;
    if (
      typeof entry?.until !== "number" ||
      !Number.isFinite(entry.until) ||
      typeof entry.strikes !== "number" ||
      !Number.isFinite(entry.strikes)
    ) {
      continue;
    }
    // Strikes outlive an expired park in-process (see `park`), and they
    // survive a restart the same way — but not forever. A record whose
    // park ended more than two ceilings ago is yesterday's evidence, and
    // restoring it would restart the ladder near the top against a quota
    // that has long since reset.
    if (entry.until + 2 * maxMs <= now) continue;
    entries.set(name as WebSearchProviderName, {
      until: entry.until,
      strikes: entry.strikes,
    });
  }
  return entries;
}

function saveCooldownFile(
  filePath: string,
  entries: Map<WebSearchProviderName, CooldownEntry>,
): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)), "utf8");
    renameSync(tmp, filePath);
  } catch {
    // Persistence is best-effort: a read-only stateDir or a full disk
    // costs the next process its warm start, never this search.
  }
}

/** `90000` -> `1m 30s`, for the line the model reads. */
export function formatCooldown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}
