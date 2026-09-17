import { describe, expect, it } from "vitest";

import { splitLargestSegment } from "./download-rebalance.js";
import type { Segment } from "./download-segments.js";

const MIN = 8;

describe("splitLargestSegment", () => {
  it("cuts the back half off the segment with the most bytes left", () => {
    const small: Segment = { start: 0, end: 32, written: 20 };
    const big: Segment = { start: 32, end: 96, written: 4 };
    const piece = splitLargestSegment([small, big], MIN);
    // 60 bytes left from 36: the donor keeps 36..66, the piece 66..96.
    expect(piece).toEqual({ start: 66, end: 96, written: 0 });
    expect(big).toEqual({ start: 32, end: 66, written: 4 });
    expect(small).toEqual({ start: 0, end: 32, written: 20 });
  });

  it("covers every byte once when the remainder is odd", () => {
    const seg: Segment = { start: 0, end: 51, written: 0 };
    const piece = splitLargestSegment([seg], MIN)!;
    expect(seg.end).toBe(piece.start);
    expect(seg.end - seg.start + (piece.end - piece.start)).toBe(51);
  });

  it("does not cut below two minimum pieces", () => {
    const seg: Segment = { start: 0, end: 40, written: 25 };
    expect(splitLargestSegment([seg], MIN)).toBeNull();
    expect(seg.end).toBe(40);
  });

  it("never cuts an open-ended stream, and has nothing to cut from nothing", () => {
    expect(
      splitLargestSegment([{ start: 0, end: Infinity, written: 0 }], MIN),
    ).toBeNull();
    expect(splitLargestSegment([], MIN)).toBeNull();
  });
});
