import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

export interface PersistentSearchCacheOptions extends SearchCacheOptions {
  /** Absolute path of the JSON file mirroring the cache on disk. */
  filePath: string;
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
  return buildCache(options, new Map<string, CacheEntry>(), undefined);
}

/**
 * The same cache, mirrored to a JSON file so it survives the process
 * (#256). Key, TTL, and eviction semantics are exactly those of
 * `createSearchCache` — only the storage changes: entries are loaded on
 * creation (rows already past their `expiresAt` are dropped, the entry
 * cap is enforced oldest-first) and written through on every `set` via
 * tmp-file + rename, so a crash never leaves a torn file. A missing or
 * corrupt file starts the cache cold; a failed write is swallowed —
 * persistence is an optimisation, and a full disk must never fail a
 * search. Concurrent processes race benignly: last writer wins.
 */
export function createPersistentSearchCache(
  options: PersistentSearchCacheOptions,
): SearchCache {
  const ttlMs = Math.max(0, options.ttlMs);
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const now = options.now ?? Date.now;
  // ttlMs 0 disables caching entirely, so there is nothing worth
  // loading and nothing that would ever be written.
  const store =
    ttlMs === 0
      ? new Map<string, CacheEntry>()
      : loadCacheFile(options.filePath, now(), maxEntries);
  const persist =
    ttlMs === 0 ? undefined : () => saveCacheFile(options.filePath, store);
  return buildCache(options, store, persist);
}

function buildCache(
  options: SearchCacheOptions,
  store: Map<string, CacheEntry>,
  persist: (() => void) | undefined,
): SearchCache {
  const ttlMs = Math.max(0, options.ttlMs);
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const now = options.now ?? Date.now;

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
      persist?.();
    },
    get size() {
      return store.size;
    },
  };
}

/** On-disk row shape: insertion order in the array is FIFO age order. */
interface PersistedCacheRow {
  key: string;
  expiresAt: number;
  value: WebSearchResult[];
}

function loadCacheFile(
  filePath: string,
  now: number,
  maxEntries: number,
): Map<string, CacheEntry> {
  const store = new Map<string, CacheEntry>();
  let rows: unknown;
  try {
    rows = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    // Missing on the very first run, or corrupt (torn by an interrupted
    // write predating the tmp+rename, or hand-edited). Either way the
    // correct recovery is a cold cache, not a crash.
    return store;
  }
  if (!Array.isArray(rows)) return store;
  for (const row of rows as Partial<PersistedCacheRow>[]) {
    if (
      typeof row?.key !== "string" ||
      typeof row.expiresAt !== "number" ||
      !Number.isFinite(row.expiresAt) ||
      !Array.isArray(row.value)
    ) {
      continue;
    }
    if (row.expiresAt <= now) continue;
    store.set(row.key, { expiresAt: row.expiresAt, value: row.value });
  }
  while (store.size > maxEntries) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  return store;
}

function saveCacheFile(filePath: string, store: Map<string, CacheEntry>): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const rows: PersistedCacheRow[] = [...store].map(([key, entry]) => ({
      key,
      expiresAt: entry.expiresAt,
      value: entry.value,
    }));
    const tmp = `${filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(rows), "utf8");
    renameSync(tmp, filePath);
  } catch {
    // Persistence is best-effort: a read-only stateDir or a full disk
    // costs the next process its warm start, never this search.
  }
}
