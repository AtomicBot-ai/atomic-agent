import { describe, it, expect } from "vitest";

/**
 * Regression: issue #121 — `bootstrap.ts` kept a `TraceRecorder` per session
 * id in a Map that had no `delete`/`clear` anywhere, so a long-lived runtime
 * serving many sessions (sidecar, HTTP server, background tasks) grew it
 * forever. There is no session-teardown hook to delete from, so the map is
 * now bounded and evicts oldest-first.
 *
 * `recorders` is a closure-private detail of `createAgentRuntime`, so this
 * pins the eviction rule itself — insertion-ordered `Map` used as an LRU —
 * which is what the bootstrap code relies on.
 */
function evictOldest<T>(map: Map<string, T>, cap: number): void {
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

describe("trace recorder map eviction (issue #121)", () => {
  it("stays at the cap no matter how many sessions arrive", () => {
    const cap = 64;
    const map = new Map<string, { id: string }>();
    for (let i = 0; i < 5_000; i += 1) {
      map.set(`s-${i}`, { id: `s-${i}` });
      evictOldest(map, cap);
    }
    expect(map.size).toBe(cap);
  });

  it("evicts oldest-first and always keeps the newest entry", () => {
    const cap = 3;
    const map = new Map<string, number>();
    for (let i = 0; i < 10; i += 1) {
      map.set(`s-${i}`, i);
      evictOldest(map, cap);
    }
    expect([...map.keys()]).toEqual(["s-7", "s-8", "s-9"]);
    // The just-inserted session must never be the one thrown away.
    expect(map.has("s-9")).toBe(true);
  });

  it("re-inserting an existing key does not evict the live entry", () => {
    // `ensureRecorder` returns early on a hit, so a repeat session id never
    // reaches the eviction loop; if it ever does, size must not grow.
    const cap = 2;
    const map = new Map<string, number>([["a", 1], ["b", 2]]);
    map.set("a", 3);
    evictOldest(map, cap);
    expect(map.size).toBe(2);
    expect(map.get("a")).toBe(3);
  });
});
