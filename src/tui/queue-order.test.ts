import { describe, expect, it } from "vitest";

import { moveQueuedMessage } from "./queue-order.js";

describe("moveQueuedMessage (ATO-2476)", () => {
  it("moves one message and keeps the order of the rest", () => {
    const q = ["a", "b", "c"];
    expect(moveQueuedMessage(q, 2, 0, 0)).toBe(0);
    expect(q).toEqual(["c", "a", "b"]);
    expect(moveQueuedMessage(q, 0, 2, 0)).toBe(0);
    expect(q).toEqual(["a", "b", "c"]);
  });

  it("keeps the refused-steer watermark a prefix of the queue", () => {
    const front = ["s1", "s2", "b1", "b2"];
    expect(moveQueuedMessage(front, 3, 0, 2)).toBe(3);
    expect(front).toEqual(["b2", "s1", "s2", "b1"]);
    const back = ["s1", "s2", "b1", "b2"];
    expect(moveQueuedMessage(back, 0, 3, 2)).toBe(1);
    expect(back).toEqual(["s2", "b1", "b2", "s1"]);
    const inside = ["s1", "s2", "b1"];
    expect(moveQueuedMessage(inside, 0, 1, 2)).toBe(2);
    expect(inside).toEqual(["s2", "s1", "b1"]);
    const edge = ["s1", "b1", "b2"];
    expect(moveQueuedMessage(edge, 2, 1, 1)).toBe(1);
    expect(edge).toEqual(["s1", "b2", "b1"]);
  });

  it("refuses an index out of range, a fraction, or a move to the same place", () => {
    const q = ["a", "b"];
    expect(moveQueuedMessage(q, 2, 0, 0)).toBeNull();
    expect(moveQueuedMessage(q, 0, 2, 0)).toBeNull();
    expect(moveQueuedMessage(q, -1, 0, 0)).toBeNull();
    expect(moveQueuedMessage(q, 0.5, 0, 0)).toBeNull();
    expect(moveQueuedMessage(q, 1, 1, 0)).toBeNull();
    expect(q).toEqual(["a", "b"]);
  });
});
