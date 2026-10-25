import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { WebSearchProviderName } from "../web-search-provider.js";

/**
 * Which tier of a provider a park was earned on. Exa has two with separate
 * quotas: its keyless MCP endpoint and its keyed API. A park from the free
 * tier says nothing about a key the user has just added, so the
 * orchestrator drops a park whose tag is not the tier it is about to use
 * (ATO-327). Untagged parks (other providers, files written before tags
 * existed) apply to every tier.
 */
export type CooldownTag = "keyless" | "keyed";

/**
 * Why a provider is parked: out of quota (a 429), or not reachable from
 * this network at all (DNS, refused, connect timeout; ATO-315). Records
 * without one (files written before it existed) are rate limits.
 */
export type CooldownReason = "rate_limited" | "unreachable";

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
    tag?: CooldownTag,
  ): number;
  /**
   * Park a provider whose host could not be reached (ATO-315). A fixed,
   * short park that does not escalate: a blocked host costs every search
   * the connect timeout, so the next few searches skip it, but a VPN that
   * comes back up is noticed within minutes. Returns the park length.
   */
  parkUnreachable(
    name: WebSearchProviderName,
    now: number,
    tag?: CooldownTag,
  ): number;
  /** The tier the current record was parked on, if it was tagged. */
  tagOf(name: WebSearchProviderName): CooldownTag | undefined;
  /** Why the current record was parked; `undefined` when there is none. */
  reasonOf(name: WebSearchProviderName): CooldownReason | undefined;
  /** A provider answered. Forget its history so the next park starts small. */
  clear(name: WebSearchProviderName): void;
}

export interface ProviderCooldownOptions {
  /** First park after a single 429. */
  baseMs?: number;
  /** Ceiling on the doubling. */
  maxMs?: number;
  /** Park after a connect failure; fixed, no doubling. */
  unreachableMs?: number;
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

/**
 * Two minutes. Long enough that a burst of searches (the model often
 * fires three at once, then three more) pays the connect timeout once
 * instead of six times; short enough that a network that comes back is
 * used again within the same task (ATO-315).
 */
const DEFAULT_UNREACHABLE_MS = 2 * 60_000;

interface CooldownEntry {
  until: number;
  /** Consecutive parks, for the doubling. */
  strikes: number;
  /** Tier the park was earned on; absent for an untagged park. */
  tag?: CooldownTag;
  /** Absent for a rate limit, the only reason before ATO-315. */
  reason?: "unreachable";
}

export function createProviderCooldown(
  options: ProviderCooldownOptions = {},
): ProviderCooldown {
  return buildCooldown(
    options,
    new Map<WebSearchProviderName, CooldownEntry>(),
    undefined,
  );
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
  const unreachableMs = options.unreachableMs ?? DEFAULT_UNREACHABLE_MS;

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
    tagOf(name) {
      return entries.get(name)?.tag;
    },
    reasonOf(name) {
      const entry = entries.get(name);
      if (!entry) return undefined;
      return entry.reason ?? "rate_limited";
    },
    parkUnreachable(name, now, tag) {
      // Strikes are the 429 ladder's history. A host that could not be
      // reached says nothing about its quota, so they are carried over
      // unchanged: neither escalated nor reset (only `clear` resets).
      const recorded = entries.get(name);
      const strikes =
        recorded?.tag !== undefined && tag !== undefined && recorded.tag !== tag
          ? 0
          : (recorded?.strikes ?? 0);
      entries.set(name, {
        until: now + unreachableMs,
        strikes,
        ...(tag !== undefined ? { tag } : {}),
        reason: "unreachable",
      });
      persist?.();
      return unreachableMs;
    },
    park(name, now, retryAfterMs, tag) {
      // Strikes earned on another tier are another quota's history: a
      // keyed Exa must not inherit the free tier's escalation (ATO-327).
      const recorded = entries.get(name);
      const previous =
        recorded?.tag !== undefined && tag !== undefined && recorded.tag !== tag
          ? undefined
          : recorded;
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
      entries.set(name, {
        until: now + parkMs,
        strikes,
        ...(tag !== undefined ? { tag } : {}),
      });
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
      // Files from before tags existed have none: untagged, as before.
      ...(entry.tag === "keyless" || entry.tag === "keyed"
        ? { tag: entry.tag }
        : {}),
      ...(entry.reason === "unreachable" ? { reason: entry.reason } : {}),
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
