import { describe, expect, it } from "vitest";

import {
  arrangeSessionRail,
  computeDroppedLayout,
  pinnedBlockLength,
  togglePinned,
} from "./session-rail-pin.js";

const row = (sessionId: string) => ({ sessionId });
const ids = (rows: readonly { sessionId: string }[]) =>
  rows.map((r) => r.sessionId);

describe("arrangeSessionRail", () => {
  it("puts the pinned block on top, ordered by `order`, above the unpinned half", () => {
    // Recency says s-5 first; the pins say s-1 and s-3 come first, s-3 ahead.
    const entries = [
      row("s-5"),
      row("s-4"),
      row("s-3"),
      row("s-2"),
      row("s-1"),
    ];
    const arranged = arrangeSessionRail(entries, {
      order: ["s-3", "s-1", "s-2", "s-4"],
      pinned: ["s-1", "s-3"],
    });
    expect(ids(arranged)).toEqual(["s-3", "s-1", "s-5", "s-2", "s-4"]);
  });

  it("keeps recency below the pins while nothing has been arranged", () => {
    const entries = [row("s-3"), row("s-2"), row("s-1")];
    const arranged = arrangeSessionRail(entries, {
      order: [],
      pinned: ["s-1"],
    });
    expect(ids(arranged)).toEqual(["s-1", "s-3", "s-2"]);
  });

  it("puts pinned ids the order has never seen at the end of the block", () => {
    const entries = [row("s-3"), row("s-2"), row("s-1")];
    const arranged = arrangeSessionRail(entries, {
      order: ["s-1"],
      pinned: ["s-1", "s-3", "s-2"],
    });
    expect(ids(arranged)).toEqual(["s-1", "s-3", "s-2"]);
  });

  it("ignores pinned ids that have no entry", () => {
    const entries = [row("s-2"), row("s-1")];
    const arranged = arrangeSessionRail(entries, {
      order: [],
      pinned: ["s-gone"],
    });
    expect(ids(arranged)).toEqual(["s-2", "s-1"]);
  });

  it("is the plain manual order when nothing is pinned", () => {
    const entries = [row("s-3"), row("s-2"), row("s-1")];
    const arranged = arrangeSessionRail(entries, {
      order: ["s-1", "s-3"],
      pinned: [],
    });
    expect(ids(arranged)).toEqual(["s-2", "s-1", "s-3"]);
  });
});

describe("pinnedBlockLength", () => {
  it("counts the displayed ids that are pinned", () => {
    expect(pinnedBlockLength(["a", "b", "c"], ["a", "b", "zzz"])).toBe(2);
    expect(pinnedBlockLength(["a", "b"], [])).toBe(0);
  });
});

describe("togglePinned", () => {
  it("pin appends the row to the end of the pinned block", () => {
    const displayed = ["p-1", "p-2", "u-1", "u-2", "u-3"];
    const next = togglePinned(
      { order: displayed, pinned: ["p-1", "p-2"] },
      displayed,
      "u-2",
    );
    expect(next).toEqual({
      order: ["p-1", "p-2", "u-2", "u-1", "u-3"],
      pinned: ["p-1", "p-2", "u-2"],
    });
  });

  it("the first pin on an unarranged rail snapshots the displayed list", () => {
    const displayed = ["s-3", "s-2", "s-1"];
    const next = togglePinned({ order: [], pinned: [] }, displayed, "s-1");
    expect(next).toEqual({ order: ["s-1", "s-3", "s-2"], pinned: ["s-1"] });
    expect(ids(arrangeSessionRail(displayed.map(row), next!))).toEqual(
      next!.order,
    );
  });

  it("unpin drops the row at the top of the unpinned half", () => {
    const displayed = ["p-1", "p-2", "p-3", "u-1", "u-2"];
    const next = togglePinned(
      { order: displayed, pinned: ["p-1", "p-2", "p-3"] },
      displayed,
      "p-1",
    );
    expect(next).toEqual({
      order: ["p-2", "p-3", "p-1", "u-1", "u-2"],
      pinned: ["p-2", "p-3"],
    });
  });

  it("unpinning the only pin leaves the row on top and the block empty", () => {
    const displayed = ["p-1", "u-1"];
    const next = togglePinned(
      { order: displayed, pinned: ["p-1"] },
      displayed,
      "p-1",
    );
    expect(next).toEqual({ order: ["p-1", "u-1"], pinned: [] });
  });

  it("prunes a pinned id that is no longer displayed", () => {
    const displayed = ["p-1", "u-1"];
    const next = togglePinned(
      { order: displayed, pinned: ["p-1", "gone"] },
      displayed,
      "u-1",
    );
    expect(next?.pinned).toEqual(["p-1", "u-1"]);
  });

  it("returns null for an id that is not on the list", () => {
    expect(togglePinned({ order: [], pinned: [] }, ["a"], "zzz")).toBeNull();
  });

  it("does not mutate its input", () => {
    const displayed = ["a", "b"];
    const layout = { order: ["a", "b"], pinned: ["a"] };
    togglePinned(layout, displayed, "b");
    expect(displayed).toEqual(["a", "b"]);
    expect(layout).toEqual({ order: ["a", "b"], pinned: ["a"] });
  });
});

describe("computeDroppedLayout", () => {
  const displayed = ["p-1", "p-2", "u-1", "u-2"];
  const layout = { order: displayed, pinned: ["p-1", "p-2"] };

  it("a drop inside the pinned block pins the row", () => {
    expect(computeDroppedLayout(layout, displayed, "u-2", 1)).toEqual({
      order: ["p-1", "u-2", "p-2", "u-1"],
      pinned: ["p-1", "u-2", "p-2"],
    });
  });

  it("a drop below the block unpins the row", () => {
    expect(computeDroppedLayout(layout, displayed, "p-1", 2)).toEqual({
      order: ["p-2", "u-1", "p-1", "u-2"],
      pinned: ["p-2"],
    });
  });

  it("a move inside one half keeps its pin state", () => {
    expect(computeDroppedLayout(layout, displayed, "p-2", 0)).toEqual({
      order: ["p-2", "p-1", "u-1", "u-2"],
      pinned: ["p-2", "p-1"],
    });
    expect(computeDroppedLayout(layout, displayed, "u-1", 3)).toEqual({
      order: ["p-1", "p-2", "u-2", "u-1"],
      pinned: ["p-1", "p-2"],
    });
  });

  it("never pins when nothing is pinned", () => {
    const flat = computeDroppedLayout(
      { order: [], pinned: [] },
      ["a", "b", "c"],
      "c",
      0,
    );
    expect(flat).toEqual({ order: ["c", "a", "b"], pinned: [] });
  });

  it("returns null for an unknown id or a drop that changes nothing", () => {
    expect(computeDroppedLayout(layout, displayed, "zzz", 0)).toBeNull();
    expect(computeDroppedLayout(layout, displayed, "p-1", 0)).toBeNull();
    expect(computeDroppedLayout(layout, displayed, "u-2", 9)).toBeNull();
  });
});
