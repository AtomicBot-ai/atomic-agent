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
 * **Per-runtime, like the result cache.** Not a global singleton and not
 * persisted: a quota window is a fact about the last few minutes, and a
 * cooldown restored from disk at start-up would park a provider on
 * yesterday's evidence.
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
  const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const entries = new Map<WebSearchProviderName, CooldownEntry>();

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
      return parkMs;
    },
    clear(name) {
      entries.delete(name);
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
