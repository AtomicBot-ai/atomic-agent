import type { WebSearchResult } from "../web-search-provider.js";

const DEFAULT_MAX_ENTRIES = 256;

export interface SearchCacheOptions {
  /** Time-to-live for an entry, in milliseconds. `0` disables caching. */
  ttlMs: number;
  /** Hard cap on stored entries; oldest are evicted FIFO. */
  maxEntries?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface SearchCache {
  get(key: string): WebSearchResult[] | undefined;
  set(key: string, value: readonly WebSearchResult[]): void;
  readonly size: number;
}

interface CacheEntry {
  expiresAt: number;
  value: WebSearchResult[];
}

/**
 * Builds a normalized cache key from the provider-selected search dimensions.
 * Distinct providers / result counts never collide.
 */
export function buildSearchCacheKey(
  provider: string,
  query: string,
  maxResults: number,
): string {
  return `${provider}\u0000${query.trim().toLowerCase()}\u0000${maxResults}`;
}

/**
 * Per-runtime, in-memory web-search result cache (NOT a global singleton — the
 * tool owns one instance in its closure). Mirrors openclaw's DDG cache: repeated
 * identical queries skip the HTTP round-trip, which is the primary defence
 * against DuckDuckGo's burst rate-limiting.
 */
export function createSearchCache(options: SearchCacheOptions): SearchCache {
  const ttlMs = Math.max(0, options.ttlMs);
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const now = options.now ?? Date.now;
  const store = new Map<string, CacheEntry>();

  return {
    get(key) {
      if (ttlMs === 0) return undefined;
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        store.delete(key);
        return undefined;
      }
      return entry.value.map((result) => ({ ...result }));
    },
    set(key, value) {
      if (ttlMs === 0) return;
      store.delete(key);
      store.set(key, {
        expiresAt: now() + ttlMs,
        value: value.map((result) => ({ ...result })),
      });
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    get size() {
      return store.size;
    },
  };
}
