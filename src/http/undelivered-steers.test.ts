import { describe, expect, it } from "vitest";

import {
  MAX_PARKED_SESSIONS,
  MAX_PARKED_STEERS,
  UndeliveredSteerStore,
} from "./undelivered-steers.js";

/**
 * The store behind `GET /api/sessions/{id}/steer`. Pins the properties
 * the route promises: reading never consumes, acking is by cursor so a
 * message parked between the read and the ack cannot be swallowed
 * unseen and the loss counter is not
 * collateral damage of that ack.
 */
describe("UndeliveredSteerStore", () => {
  it("keeps parked messages until they are acked", () => {
    const store = new UndeliveredSteerStore();
    const parked = store.park("s1", ["stop", "do X instead"]);
    expect(parked.map((e) => e.text)).toEqual(["stop", "do X instead"]);
    expect(store.list("s1")).toHaveLength(2);
    // Reading twice returns the same rows — a retried GET is safe.
    expect(store.list("s1")).toHaveLength(2);
    expect(store.ack("s1", parked[1]!.seq)).toBe(2);
    expect(store.list("s1")).toEqual([]);
  });

  it("isolates sessions", () => {
    const store = new UndeliveredSteerStore();
    store.park("s1", ["for one"]);
    store.park("s2", ["for two"]);
    store.ack("s1", Number.MAX_SAFE_INTEGER);
    expect(store.list("s1")).toEqual([]);
    expect(store.list("s2").map((e) => e.text)).toEqual(["for two"]);
  });

  it("acks by cursor, so anything parked after the read survives", () => {
    const store = new UndeliveredSteerStore();
    const seen = store.park("s1", ["first"]);
    const later = store.park("s1", ["arrived after the GET"]);
    expect(store.ack("s1", seen[0]!.seq)).toBe(1);
    expect(store.list("s1").map((e) => e.seq)).toEqual([later[0]!.seq]);
  });

  it("is a no-op for an empty hand-back and for an unknown session", () => {
    const store = new UndeliveredSteerStore();
    expect(store.park("s1", [])).toEqual([]);
    expect(store.list("s1")).toEqual([]);
    expect(store.ack("nope", 10)).toBe(0);
    expect(store.discarded("nope")).toBe(0);
  });

  it("counts what the per-session cap discards instead of quietly shortening the list", () => {
    const store = new UndeliveredSteerStore();
    // The cap bites across hand-backs: fill it, then strand three more.
    const first = Array.from({ length: MAX_PARKED_STEERS }, (_, i) => `m${i}`);
    store.park("s1", first);
    const second = store.park("s1", ["late-1", "late-2", "late-3"]);
    expect(store.list("s1")).toHaveLength(MAX_PARKED_STEERS);
    expect(store.discarded("s1")).toBe(3);
    // The three oldest went; what the latest caller is told it can
    // retrieve matches what is actually retrievable.
    expect(second.map((e) => e.text)).toEqual(["late-1", "late-2", "late-3"]);
    expect(store.list("s1")[0]?.text).toBe("m3");
    expect(store.list("s1").at(-1)?.text).toBe("late-3");
  });

  it("keeps the loss counter when the host acks the entries it was shown", () => {
    const store = new UndeliveredSteerStore();
    store.park("s1", Array.from({ length: MAX_PARKED_STEERS }, (_, i) => `m${i}`));
    store.park("s1", ["late-1", "late-2", "late-3"]);
    expect(store.discarded("s1")).toBe(3);
    // Acking the highest seq in the listing is what a host does first;
    // the discarded messages were never in that listing and have no
    // seq it could point at, so this must not clear them.
    const listed = store.list("s1");
    store.ack("s1", listed.at(-1)!.seq);
    expect(store.list("s1")).toEqual([]);
    expect(store.discarded("s1")).toBe(3);
    // The box survives the entry ack precisely so the counter can.
    expect(store.trackedSessions).toBe(1);
  });

  it("clears the loss counter only by its own ack, and reclaims the box then", () => {
    const store = new UndeliveredSteerStore();
    store.park("s1", Array.from({ length: MAX_PARKED_STEERS }, (_, i) => `m${i}`));
    store.park("s1", ["late-1", "late-2", "late-3"]);
    store.ack("s1", store.list("s1").at(-1)!.seq);
    // By count, not by flag: a partial ack leaves the rest outstanding,
    // so discards that happened after the host's GET are not cleared
    // unseen.
    expect(store.ackDiscarded("s1", 1)).toBe(1);
    expect(store.discarded("s1")).toBe(2);
    expect(store.trackedSessions).toBe(1);
    // Over-acking clamps rather than going negative, and is idempotent.
    expect(store.ackDiscarded("s1", 99)).toBe(2);
    expect(store.ackDiscarded("s1", 99)).toBe(0);
    expect(store.discarded("s1")).toBe(0);
    expect(store.trackedSessions).toBe(0);
  });

  it("still reclaims a discard-only box on purge and on session eviction", () => {
    const store = new UndeliveredSteerStore();
    const overflow = (id: string): void => {
      store.park(id, Array.from({ length: MAX_PARKED_STEERS }, (_, i) => `m${i}`));
      store.park(id, ["one too many"]);
      store.ack(id, Number.MAX_SAFE_INTEGER);
    };
    overflow("purged");
    expect(store.discarded("purged")).toBe(1);
    store.clear("purged");
    expect(store.discarded("purged")).toBe(0);
    expect(store.trackedSessions).toBe(0);

    // A host that never acks anything cannot pin boxes open forever:
    // the session cap still evicts the oldest.
    overflow("stale");
    for (let i = 0; i < MAX_PARKED_SESSIONS; i += 1) {
      store.park(`s${i}`, ["x"]);
    }
    expect(store.trackedSessions).toBe(MAX_PARKED_SESSIONS);
    expect(store.discarded("stale")).toBe(0);
  });

  it("forgets a session on clear", () => {
    const store = new UndeliveredSteerStore();
    store.park("s1", ["gone with the session"]);
    store.clear("s1");
    expect(store.list("s1")).toEqual([]);
    store.park("s2", ["x"]);
    store.clearAll();
    expect(store.list("s2")).toEqual([]);
  });
});
