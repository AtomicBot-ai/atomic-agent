import { describe, it, expect } from "vitest";

/**
 * Regression: issue #121 — `bootstrap.ts` kept a `TraceRecorder` per session
 * id in a Map that had no `delete`/`clear` anywhere, so a long-lived runtime
 * serving many sessions (sidecar, HTTP server, background tasks) grew it
 * forever. The map is now bounded, evicts least-recently-*used* first, and
 * never evicts a session with a turn in flight.
 *
 * `recorders` is a closure-private detail of `createAgentRuntime`, so this
 * mirrors the three helpers it uses (`touchRecorder`, `dropRecorder`,
 * `evictRecorders`) and pins the rules they implement. An earlier version of
 * this file re-implemented plain insertion-order eviction and so agreed with
 * the bug it was meant to catch: `Map` preserves insertion order, which is
 * not recency, so the oldest-*created* session was evicted even while it was
 * the one actively running.
 */
function makeRecorderMap(cap: number) {
  const recorders = new Map<string, { id: string }>();
  const active = new Set<string>();

  const touch = (id: string) => {
    const found = recorders.get(id);
    if (found !== undefined) {
      recorders.delete(id);
      recorders.set(id, found);
    }
    return found;
  };

  const evict = () => {
    if (recorders.size <= cap) return;
    for (const id of [...recorders.keys()]) {
      if (recorders.size <= cap) break;
      if (active.has(id)) continue;
      recorders.delete(id);
    }
  };

  return {
    recorders,
    active,
    touch,
    evict,
    ensure(id: string) {
      const existing = touch(id);
      if (existing) return existing;
      const created = { id };
      recorders.set(id, created);
      evict();
      return created;
    },
    drop(id: string) {
      recorders.delete(id);
      active.delete(id);
    },
  };
}

describe("trace recorder map eviction (issue #121)", () => {
  it("stays at the cap no matter how many sessions arrive", () => {
    const m = makeRecorderMap(64);
    for (let i = 0; i < 5_000; i += 1) m.ensure(`s-${i}`);
    expect(m.recorders.size).toBe(64);
  });

  it("keeps the newest entry and drops the least recently used", () => {
    const m = makeRecorderMap(3);
    for (let i = 0; i < 10; i += 1) m.ensure(`s-${i}`);
    expect([...m.recorders.keys()]).toEqual(["s-7", "s-8", "s-9"]);
  });

  it("a session that keeps working is not evicted by newer arrivals", () => {
    // The bug: insertion order never refreshed on a hit, so the oldest
    // *created* session — usually the operator's own long-running one — was
    // the first thrown away no matter how recently it had spoken.
    const m = makeRecorderMap(3);
    m.ensure("operator");
    for (let i = 0; i < 20; i += 1) {
      m.ensure(`sidecar-${i}`);
      m.ensure("operator"); // still working
    }
    expect(m.recorders.has("operator")).toBe(true);
  });

  it("never evicts a session with a turn in flight", () => {
    // Losing a running session's recorder mid-turn silently drops the rest
    // of that turn's events, so an active session outranks the cap.
    const m = makeRecorderMap(3);
    m.ensure("busy");
    m.active.add("busy");
    for (let i = 0; i < 50; i += 1) m.ensure(`other-${i}`);
    expect(m.recorders.has("busy")).toBe(true);

    // Once the turn ends it becomes evictable like anything else.
    m.active.delete("busy");
    for (let i = 0; i < 50; i += 1) m.ensure(`later-${i}`);
    expect(m.recorders.has("busy")).toBe(false);
  });

  it("deleting a session drops its recorder immediately", () => {
    const m = makeRecorderMap(64);
    m.ensure("gone");
    expect(m.recorders.has("gone")).toBe(true);
    m.drop("gone");
    expect(m.recorders.has("gone")).toBe(false);
    expect(m.active.has("gone")).toBe(false);
  });

  it("re-inserting an existing key does not grow the map", () => {
    const m = makeRecorderMap(2);
    m.ensure("a");
    m.ensure("b");
    m.ensure("a");
    expect(m.recorders.size).toBe(2);
  });
});
