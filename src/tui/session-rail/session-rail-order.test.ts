import { describe, expect, it } from "vitest";

import {
  applySessionRailOrder,
  computeMovedOrder,
  moveSessionInOrder,
  pruneSessionRailOrder,
} from "./session-rail-order.js";

const row = (sessionId: string) => ({ sessionId });
const ids = (rows: readonly { sessionId: string }[]) => rows.map((r) => r.sessionId);

describe("applySessionRailOrder", () => {
  it("keeps the recency order while nothing has been arranged", () => {
    const entries = [row("s-3"), row("s-2"), row("s-1")];
    expect(ids(applySessionRailOrder(entries, []))).toEqual(["s-3", "s-2", "s-1"]);
  });

  it("follows the manual order", () => {
    const entries = [row("s-3"), row("s-2"), row("s-1")];
    const arranged = applySessionRailOrder(entries, ["s-1", "s-3", "s-2"]);
    expect(ids(arranged)).toEqual(["s-1", "s-3", "s-2"]);
  });

  it("puts sessions the order has never seen on top, newest first", () => {
    // s-5 and s-4 were started after the operator arranged the list;
    // the store lists them first because they are the most recent.
    const entries = [row("s-5"), row("s-1"), row("s-4"), row("s-2"), row("s-3")];
    const arranged = applySessionRailOrder(entries, ["s-1", "s-3", "s-2"]);
    expect(ids(arranged)).toEqual(["s-5", "s-4", "s-1", "s-3", "s-2"]);
  });

  it("ignores ids in the order that have no row", () => {
    const entries = [row("s-2"), row("s-1")];
    const arranged = applySessionRailOrder(entries, ["s-gone", "s-1", "s-2"]);
    expect(ids(arranged)).toEqual(["s-1", "s-2"]);
  });

  it("does not mutate its input", () => {
    const entries = [row("s-2"), row("s-1")];
    applySessionRailOrder(entries, ["s-1", "s-2"]);
    expect(ids(entries)).toEqual(["s-2", "s-1"]);
  });
});

describe("moveSessionInOrder", () => {
  it("moves a row up", () => {
    expect(moveSessionInOrder(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("moves a row down", () => {
    expect(moveSessionInOrder(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("clamps both ends", () => {
    expect(moveSessionInOrder(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
    expect(moveSessionInOrder(["a", "b", "c"], 2, -5)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op when source and target coincide", () => {
    const input = ["a", "b", "c"];
    expect(moveSessionInOrder(input, 1, 1)).toEqual(input);
    expect(moveSessionInOrder(input, 0, -1)).toEqual(input);
    expect(moveSessionInOrder([], 0, 1)).toEqual([]);
  });
});

describe("computeMovedOrder", () => {
  it("returns the snapshot with the row in its new slot", () => {
    expect(computeMovedOrder(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
  });

  it("returns null for an unknown id or a move that changes nothing", () => {
    expect(computeMovedOrder(["a", "b"], "zzz", 0)).toBeNull();
    expect(computeMovedOrder(["a", "b"], "a", 0)).toBeNull();
    expect(computeMovedOrder(["a", "b"], "b", 5)).toBeNull();
  });
});

describe("pruneSessionRailOrder", () => {
  it("drops ids that are no longer live, keeping the order", () => {
    expect(pruneSessionRailOrder(["b", "gone", "a"], ["a", "b", "new"])).toEqual([
      "b",
      "a",
    ]);
  });
});
