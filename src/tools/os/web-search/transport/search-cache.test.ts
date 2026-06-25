import { describe, expect, it } from "vitest";

import { buildSearchCacheKey, createSearchCache } from "./search-cache.js";
import type { WebSearchResult } from "../web-search-provider.js";

const RESULTS: WebSearchResult[] = [
  { title: "A", url: "https://a.example", snippet: "a" },
];

describe("search-cache", () => {
  it("returns a stored value within TTL (hit)", () => {
    const cache = createSearchCache({ ttlMs: 1000, now: () => 0 });
    cache.set("k", RESULTS);
    expect(cache.get("k")).toEqual(RESULTS);
  });

  it("returns undefined for an unknown key (miss)", () => {
    const cache = createSearchCache({ ttlMs: 1000, now: () => 0 });
    expect(cache.get("nope")).toBeUndefined();
  });

  it("expires entries past the TTL", () => {
    let clock = 0;
    const cache = createSearchCache({ ttlMs: 1000, now: () => clock });
    cache.set("k", RESULTS);
    clock = 1001;
    expect(cache.get("k")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts oldest entries FIFO past maxEntries", () => {
    const cache = createSearchCache({ ttlMs: 1000, maxEntries: 2, now: () => 0 });
    cache.set("a", RESULTS);
    cache.set("b", RESULTS);
    cache.set("c", RESULTS);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual(RESULTS);
    expect(cache.get("c")).toEqual(RESULTS);
  });

  it("disables caching entirely when ttlMs is 0", () => {
    const cache = createSearchCache({ ttlMs: 0, now: () => 0 });
    cache.set("k", RESULTS);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("returns a defensive copy (mutating the result does not poison the cache)", () => {
    const cache = createSearchCache({ ttlMs: 1000, now: () => 0 });
    cache.set("k", RESULTS);
    const first = cache.get("k");
    first![0]!.title = "mutated";
    expect(cache.get("k")?.[0]?.title).toBe("A");
  });

  it("builds distinct keys per provider, query, and maxResults", () => {
    const a = buildSearchCacheKey("duckduckgo", "Foo Bar", 5);
    const b = buildSearchCacheKey("exa", "Foo Bar", 5);
    const c = buildSearchCacheKey("duckduckgo", "foo bar", 5);
    const d = buildSearchCacheKey("duckduckgo", "Foo Bar", 8);
    expect(a).not.toBe(b);
    expect(a).toBe(c); // case-insensitive, trimmed
    expect(a).not.toBe(d);
  });
});
