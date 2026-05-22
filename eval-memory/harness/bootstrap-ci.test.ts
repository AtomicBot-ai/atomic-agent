import { describe, expect, it } from "vitest";

import {
  bootstrap,
  bootstrapDelta,
  mean,
  seededRng,
} from "./bootstrap-ci.js";

describe("bootstrap", () => {
  it("returns a degenerate CI for an empty sample", () => {
    const r = bootstrap([]);
    expect(r).toEqual({ point: 0, ciLow: 0, ciHigh: 0, iterations: 0, n: 0 });
  });

  it("returns a degenerate CI for a single observation", () => {
    const r = bootstrap([42]);
    expect(r.point).toBe(42);
    expect(r.ciLow).toBe(42);
    expect(r.ciHigh).toBe(42);
    expect(r.iterations).toBe(0);
    expect(r.n).toBe(1);
  });

  it("recovers the mean and a sensible CI on a small constant-ish sample", () => {
    const sample = [4, 4, 5, 4, 5, 4, 5, 5, 4, 5];
    const r = bootstrap(sample, { iterations: 1000, rng: seededRng(42) });
    expect(r.point).toBeCloseTo(4.5, 5);
    expect(r.ciLow).toBeGreaterThanOrEqual(4);
    expect(r.ciHigh).toBeLessThanOrEqual(5);
    expect(r.ciLow).toBeLessThanOrEqual(r.point);
    expect(r.ciHigh).toBeGreaterThanOrEqual(r.point);
  });

  it("widens the CI as the sample variance grows", () => {
    const tight = bootstrap([3, 3, 3, 3, 3, 3, 3, 3, 3, 4], {
      iterations: 1000,
      rng: seededRng(7),
    });
    const wide = bootstrap([1, 5, 1, 5, 1, 5, 1, 5, 1, 5], {
      iterations: 1000,
      rng: seededRng(7),
    });
    expect(wide.ciHigh - wide.ciLow).toBeGreaterThan(tight.ciHigh - tight.ciLow);
  });

  it("is deterministic for a given seed", () => {
    const sample = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = bootstrap(sample, { iterations: 500, rng: seededRng(123) });
    const b = bootstrap(sample, { iterations: 500, rng: seededRng(123) });
    expect(a).toEqual(b);
  });
});

describe("bootstrapDelta", () => {
  it("rejects mismatched arms", () => {
    expect(() => bootstrapDelta([1, 2], [1, 2, 3])).toThrow();
  });

  it("CI excludes 0 when one arm is strictly better", () => {
    const a = [5, 5, 5, 5, 5, 5, 5, 5];
    const b = [3, 3, 3, 3, 3, 3, 3, 3];
    const r = bootstrapDelta(a, b, { iterations: 1000, rng: seededRng(1) });
    expect(r.point).toBe(2);
    expect(r.ciLow).toBeGreaterThan(0);
  });

  it("CI straddles 0 when the two arms are interleaved noise", () => {
    const a = [4, 5, 4, 5, 4, 5];
    const b = [5, 4, 5, 4, 5, 4];
    const r = bootstrapDelta(a, b, { iterations: 1000, rng: seededRng(2) });
    expect(r.ciLow).toBeLessThanOrEqual(0);
    expect(r.ciHigh).toBeGreaterThanOrEqual(0);
  });
});

describe("mean", () => {
  it("returns 0 on empty input", () => {
    expect(mean([])).toBe(0);
  });
  it("matches the textbook arithmetic mean", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });
});

describe("seededRng", () => {
  it("returns the same sequence for the same seed", () => {
    const a = seededRng(99);
    const b = seededRng(99);
    for (let i = 0; i < 5; i += 1) expect(a()).toBe(b());
  });
  it("returns numbers in [0, 1)", () => {
    const rng = seededRng(13);
    for (let i = 0; i < 100; i += 1) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
