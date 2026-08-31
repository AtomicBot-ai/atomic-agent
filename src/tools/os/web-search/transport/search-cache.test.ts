import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildSearchCacheKey,
  createPersistentSearchCache,
  createSearchCache,
} from "./search-cache.js";
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

describe("createPersistentSearchCache (#256)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "search-cache-"));
    filePath = join(dir, "web-search-cache.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips entries: a second instance from the same file serves the hit", () => {
    const first = createPersistentSearchCache({
      ttlMs: 1000,
      filePath,
      now: () => 0,
    });
    first.set("k", RESULTS);

    const second = createPersistentSearchCache({
      ttlMs: 1000,
      filePath,
      now: () => 500,
    });
    expect(second.get("k")).toEqual(RESULTS);
  });

  it("drops rows already past their expiresAt on load", () => {
    const first = createPersistentSearchCache({
      ttlMs: 1000,
      filePath,
      now: () => 0,
    });
    first.set("k", RESULTS);

    const second = createPersistentSearchCache({
      ttlMs: 1000,
      filePath,
      now: () => 1001,
    });
    expect(second.size).toBe(0);
    expect(second.get("k")).toBeUndefined();
  });

  it("enforces the entry cap on load, evicting oldest first", () => {
    const first = createPersistentSearchCache({
      ttlMs: 1000,
      maxEntries: 3,
      filePath,
      now: () => 0,
    });
    first.set("a", RESULTS);
    first.set("b", RESULTS);
    first.set("c", RESULTS);

    const second = createPersistentSearchCache({
      ttlMs: 1000,
      maxEntries: 2,
      filePath,
      now: () => 0,
    });
    expect(second.size).toBe(2);
    expect(second.get("a")).toBeUndefined();
    expect(second.get("b")).toEqual(RESULTS);
    expect(second.get("c")).toEqual(RESULTS);
  });

  it("starts cold on a missing file", () => {
    const cache = createPersistentSearchCache({
      ttlMs: 1000,
      filePath,
      now: () => 0,
    });
    expect(cache.size).toBe(0);
    expect(cache.get("k")).toBeUndefined();
  });

  it("starts cold on a corrupt file instead of throwing, and set repairs it", () => {
    writeFileSync(filePath, "{not json[", "utf8");
    const cache = createPersistentSearchCache({
      ttlMs: 1000,
      filePath,
      now: () => 0,
    });
    expect(cache.size).toBe(0);

    cache.set("k", RESULTS);
    const repaired = createPersistentSearchCache({
      ttlMs: 1000,
      filePath,
      now: () => 0,
    });
    expect(repaired.get("k")).toEqual(RESULTS);
  });

  it("skips malformed rows without dropping the valid ones", () => {
    writeFileSync(
      filePath,
      JSON.stringify([
        { key: 42, expiresAt: 1000, value: RESULTS },
        { key: "no-expiry", value: RESULTS },
        { key: "ok", expiresAt: 1000, value: RESULTS },
      ]),
      "utf8",
    );
    const cache = createPersistentSearchCache({
      ttlMs: 1000,
      filePath,
      now: () => 0,
    });
    expect(cache.size).toBe(1);
    expect(cache.get("ok")).toEqual(RESULTS);
  });

  it("writes nothing when ttlMs is 0 (caching disabled)", () => {
    const cache = createPersistentSearchCache({
      ttlMs: 0,
      filePath,
      now: () => 0,
    });
    cache.set("k", RESULTS);
    expect(existsSync(filePath)).toBe(false);
  });
});
