import type { WebSearchProviderName } from "../web-search-provider.js";
import {
  loadCooldownFile,
  saveCooldownFile,
  type CooldownEntry,
} from "./provider-cooldown-file.js";

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
 * this network at all (DNS, refused, connect timeout; ATO-315).
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
   * short park that does not escalate and is never written to disk: a
   * blocked host costs every search the connect timeout, so searches that
   * start after the failure skip it for a while, but one network blip
   * must not outlive the process that saw it. Kept apart from the 429
   * record, whose strikes it neither raises nor resets. Returns the
   * park length.
   */
  parkUnreachable(
    name: WebSearchProviderName,
    now: number,
    tag?: CooldownTag,
  ): number;
  /** The tier the current record was parked on, if it was tagged. */
  tagOf(name: WebSearchProviderName): CooldownTag | undefined;
  /**
   * Why `name` is parked at `now`: a live 429 park wins over an
   * unreachable one; `undefined` when neither is live.
   */
  reasonOf(
    name: WebSearchProviderName,
    now: number,
  ): CooldownReason | undefined;
  /**
   * May an unreachable-parked `name` be asked anyway, now? True at most
   * once per `UNREACHABLE_PROBE_INTERVAL_MS` since it last failed or was
   * last probed, and records the probe. The orchestrator asks only when
   * every provider is parked unreachable (ATO-315).
   */
  takeProbe(name: WebSearchProviderName, now: number): boolean;
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
 * Two minutes. Searches that start after a connect failure skip the host
 * for this long instead of each waiting out the connect timeout; short
 * enough that a network that comes back is used again within the same
 * task (ATO-315).
 */
const DEFAULT_UNREACHABLE_MS = 2 * 60_000;

/**
 * How often a chain whose every provider is parked unreachable gets one
 * request anyway. A firewall that drops packets costs the full connect
 * timeout per try, so not on every search; a network that came back is
 * still found within half a minute (ATO-315).
 */
export const UNREACHABLE_PROBE_INTERVAL_MS = 30_000;

/** An unreachable park: in memory only, no strikes. */
interface UnreachableEntry {
  until: number;
  tag?: CooldownTag;
  /** When it last failed or was probed. */
  triedAt: number;
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
  // Never persisted: a blip one process saw is not the next one's fact.
  const unreachable = new Map<WebSearchProviderName, UnreachableEntry>();

  function left(entry: { until: number } | undefined, now: number): number {
    return entry ? Math.max(0, entry.until - now) : 0;
  }

  function remainingMs(name: WebSearchProviderName, now: number): number {
    return Math.max(
      left(entries.get(name), now),
      left(unreachable.get(name), now),
    );
  }

  return {
    remainingMs,
    isParked(name, now) {
      return remainingMs(name, now) > 0;
    },
    tagOf(name) {
      return entries.get(name)?.tag ?? unreachable.get(name)?.tag;
    },
    reasonOf(name, now) {
      if (left(entries.get(name), now) > 0) return "rate_limited";
      if (left(unreachable.get(name), now) > 0) return "unreachable";
      return undefined;
    },
    parkUnreachable(name, now, tag) {
      unreachable.set(name, {
        until: now + unreachableMs,
        ...(tag !== undefined ? { tag } : {}),
        triedAt: now,
      });
      return unreachableMs;
    },
    takeProbe(name, now) {
      const entry = unreachable.get(name);
      if (!entry || now - entry.triedAt < UNREACHABLE_PROBE_INTERVAL_MS) {
        return false;
      }
      entry.triedAt = now;
      return true;
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
      unreachable.delete(name);
      if (entries.delete(name)) persist?.();
    },
  };
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
