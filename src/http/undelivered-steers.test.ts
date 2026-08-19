import { describe, expect, it } from "vitest";

import {
  MAX_PARKED_STEERS,
  UndeliveredSteerStore,
} from "./undelivered-steers.js";

/**
 * The store behind `GET /api/sessions/{id}/steer`. Pins the two
 * properties the route promises: reading never consumes, and acking is
 * by cursor so a message parked between the read and the ack cannot be
 * swallowed unseen.
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
    const texts = Array.from({ length: MAX_PARKED_STEERS + 3 }, (_, i) => `m${i}`);
    const parked = store.park("s1", texts);
    expect(store.list("s1")).toHaveLength(MAX_PARKED_STEERS);
    expect(store.discarded("s1")).toBe(3);
    // The oldest went; what the caller is told it can retrieve matches
    // what is actually retrievable.
    expect(parked.map((e) => e.text)).toEqual(texts.slice(3));
    expect(store.list("s1")[0]?.text).toBe("m3");
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
