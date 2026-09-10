import { describe, expect, it } from "vitest";

import {
  applySessionRailOrder,
  computeMovedOrder,
  moveSessionInOrder,
  pruneSessionRailOrder,
} from "./session-rail-order.js";

/**
 * A rail row. `updatedAt` defaults to a descending stamp derived from
 * the id's trailing digit, so `row("s-3")` is newer than `row("s-1")`
 * and the fixtures below read the way the store hands them over: newest
 * first. Pass a stamp explicitly where the date is the point.
 */
const row = (sessionId: string, updatedAt?: number) => ({
  sessionId,
  updatedAt: updatedAt ?? Number(sessionId.replace(/\D/g, "") || 0) * 1000,
});
const ids = (rows: readonly { sessionId: string }[]) =>
  rows.map((r) => r.sessionId);

describe("applySessionRailOrder", () => {
  it("keeps the recency order while nothing has been arranged", () => {
    const entries = [row("s-3"), row("s-2"), row("s-1")];
    expect(ids(applySessionRailOrder(entries, []))).toEqual([
      "s-3",
      "s-2",
      "s-1",
    ]);
  });

  it("follows the manual order", () => {
    const entries = [row("s-3"), row("s-2"), row("s-1")];
    const arranged = applySessionRailOrder(entries, ["s-1", "s-3", "s-2"]);
    expect(ids(arranged)).toEqual(["s-1", "s-3", "s-2"]);
  });

  it("puts sessions the order has never seen where their date earns it", () => {
    // s-5 and s-4 were started after the operator arranged the list, so
    // they are newer than every arranged row and land on top of it.
    const entries = [
      row("s-5"),
      row("s-1"),
      row("s-4"),
      row("s-2"),
      row("s-3"),
    ];
    const arranged = applySessionRailOrder(entries, ["s-1", "s-3", "s-2"]);
    expect(ids(arranged)).toEqual(["s-5", "s-4", "s-1", "s-3", "s-2"]);
  });

  it("drops an old import in among the rows of its own age, not on top", () => {
    // The arranged rail holds this year's work; the import has just
    // written a transcript from four years ago. It belongs at the
    // bottom, beside the other old rows — not above today's thread.
    const arrangedRows = [
      row("s-now", 4_000),
      row("s-mid", 3_000),
      row("s-old", 1_000),
    ];
    const imported = row("s-import", 2_000);
    const arranged = applySessionRailOrder(
      [imported, ...arrangedRows],
      ["s-now", "s-mid", "s-old"],
    );
    expect(ids(arranged)).toEqual(["s-now", "s-mid", "s-import", "s-old"]);
  });

  it("keeps a hand-arranged list from throwing a newcomer to the top", () => {
    // The operator dragged the oldest thread to the top, so the list is
    // in no date order at all. A newcomer older than two of the three
    // rows still sits below both of them.
    const entries = [
      row("s-import", 2_000),
      row("s-old", 1_000),
      row("s-now", 4_000),
      row("s-mid", 3_000),
    ];
    const arranged = applySessionRailOrder(entries, [
      "s-old",
      "s-now",
      "s-mid",
    ]);
    expect(ids(arranged)).toEqual(["s-old", "s-now", "s-mid", "s-import"]);
  });

  it("keeps newcomers of the same age in the order they arrived", () => {
    // A batch of imports written in one pass shares a timestamp; the
    // list must not come out reversed.
    const entries = [row("s-a", 2_000), row("s-b", 2_000), row("s-c", 2_000)];
    const arranged = applySessionRailOrder(entries, ["s-keep"]);
    expect(ids(arranged)).toEqual(["s-a", "s-b", "s-c"]);
  });

  it("keeps several newcomers in their own recency order", () => {
    const entries = [
      row("s-a", 5_000),
      row("s-b", 1_500),
      row("s-keep", 2_000),
    ];
    const arranged = applySessionRailOrder(entries, ["s-keep"]);
    expect(ids(arranged)).toEqual(["s-a", "s-keep", "s-b"]);
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
    expect(
      pruneSessionRailOrder(["b", "gone", "a"], ["a", "b", "new"]),
    ).toEqual(["b", "a"]);
  });
});
