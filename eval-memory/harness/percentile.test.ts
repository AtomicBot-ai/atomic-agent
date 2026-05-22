import { describe, it, expect } from "vitest";

import { percentile, meanP50P95 } from "./percentile.js";

describe("percentile", () => {
  it("returns 0 on empty input", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([], 0.95)).toBe(0);
  });

  it("returns the single value when n=1, regardless of fraction", () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
  });

  it("interpolates between adjacent ranks (numpy type 7 semantics)", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
    expect(percentile([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85, 10);
    expect(percentile([1, 2, 3, 4], 0.0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 1.0)).toBe(4);
  });

  it("does not mutate the input array", () => {
    const xs = [3, 1, 2];
    const before = [...xs];
    percentile(xs, 0.5);
    expect(xs).toEqual(before);
  });

  it("handles unsorted input", () => {
    expect(percentile([4, 2, 1, 3], 0.5)).toBeCloseTo(2.5, 10);
  });

  it("clamps fractions outside [0,1] to min / max", () => {
    expect(percentile([1, 5, 9], -0.1)).toBe(1);
    expect(percentile([1, 5, 9], 1.1)).toBe(9);
  });
});

describe("meanP50P95", () => {
  it("returns all-zero triple on empty input", () => {
    const r = meanP50P95([]);
    expect(r).toEqual({ mean: 0, p50: 0, p95: 0 });
  });

  it("returns mean, p50 (median), p95 for a small sample", () => {
    const r = meanP50P95([1, 2, 3, 4]);
    expect(r.mean).toBe(2.5);
    expect(r.p50).toBeCloseTo(2.5, 10);
    expect(r.p95).toBeCloseTo(3.85, 10);
  });

  it("on a uniformly increasing sample, p50 ≈ median, p95 ≈ near-max", () => {
    const xs = Array.from({ length: 21 }, (_, i) => i); // 0..20
    const r = meanP50P95(xs);
    expect(r.mean).toBe(10);
    expect(r.p50).toBe(10);
    expect(r.p95).toBe(19);
  });
});
