import { describe, it, expect } from "vitest";

import {
  stratifiedSample,
  summariseStrata,
} from "./stratified-sample.js";
import { seededRng } from "./bootstrap-ci.js";

interface Item {
  category: string;
  id: number;
}

function makeItems(): Item[] {
  // 4 categories with skewed sizes — mirrors LoCoMo's distribution.
  const out: Item[] = [];
  let id = 0;
  for (let i = 0; i < 100; i += 1) out.push({ category: "A", id: id++ });
  for (let i = 0; i < 50; i += 1) out.push({ category: "B", id: id++ });
  for (let i = 0; i < 20; i += 1) out.push({ category: "C", id: id++ });
  for (let i = 0; i < 10; i += 1) out.push({ category: "D", id: id++ });
  return out;
}

describe("stratifiedSample", () => {
  it("returns an empty array on empty input", () => {
    expect(stratifiedSample([], () => "x", 0.5, seededRng(1))).toEqual([]);
  });

  it("returns a clone when fraction >= 1", () => {
    const items = [1, 2, 3];
    const out = stratifiedSample(items, (x) => `k${x}`, 1, seededRng(1));
    expect(out).toEqual(items);
    expect(out).not.toBe(items);
  });

  it("returns an empty array when fraction <= 0 and no minPerStratum", () => {
    const items = makeItems();
    const out = stratifiedSample(items, (it) => it.category, 0, seededRng(1));
    expect(out).toEqual([]);
  });

  it("preserves per-stratum proportions (rounded)", () => {
    const items = makeItems();
    const out = stratifiedSample(items, (it) => it.category, 0.5, seededRng(7));
    const beforeBy = countBy(items, (it) => it.category);
    const afterBy = countBy(out, (it) => it.category);
    // round(100*0.5)=50, round(50*0.5)=25, round(20*0.5)=10, round(10*0.5)=5
    expect(afterBy.A).toBe(50);
    expect(afterBy.B).toBe(25);
    expect(afterBy.C).toBe(10);
    expect(afterBy.D).toBe(5);
    expect(out.length).toBe(50 + 25 + 10 + 5);
    // every stratum present in input must still appear unless rounded to 0
    for (const k of Object.keys(beforeBy)) {
      expect(afterBy[k]).toBeGreaterThan(0);
    }
  });

  it("is deterministic for a fixed seed", () => {
    const items = makeItems();
    const a = stratifiedSample(items, (it) => it.category, 0.3, seededRng(42));
    const b = stratifiedSample(items, (it) => it.category, 0.3, seededRng(42));
    expect(a).toEqual(b);
  });

  it("yields a different subset for a different seed (with high probability)", () => {
    const items = makeItems();
    const a = stratifiedSample(items, (it) => it.category, 0.3, seededRng(1));
    const b = stratifiedSample(items, (it) => it.category, 0.3, seededRng(2));
    expect(a.length).toBe(b.length);
    expect(a).not.toEqual(b);
  });

  it("respects minPerStratum when fraction would round to zero", () => {
    const items = makeItems();
    // fraction 0.01 → strata A=1, B=1 (rounded), C=0, D=0. minPerStratum=3
    // should raise C and D to 3 (and A,B to 3 too, since min wins over round).
    const out = stratifiedSample(items, (it) => it.category, 0.01, seededRng(1), {
      minPerStratum: 3,
    });
    const afterBy = countBy(out, (it) => it.category);
    expect(afterBy.A).toBeGreaterThanOrEqual(3);
    expect(afterBy.B).toBeGreaterThanOrEqual(3);
    expect(afterBy.C).toBeGreaterThanOrEqual(3);
    expect(afterBy.D).toBeGreaterThanOrEqual(3);
  });

  it("clamps minPerStratum to stratum size for tiny strata", () => {
    const items = [
      { k: "A", id: 1 },
      { k: "A", id: 2 },
      { k: "B", id: 3 },
    ];
    const out = stratifiedSample(items, (it) => it.k, 0, seededRng(1), {
      minPerStratum: 10,
    });
    const afterBy = countBy(out, (it) => it.k);
    expect(afterBy.A).toBe(2);
    expect(afterBy.B).toBe(1);
  });

  it("preserves original input order in the output", () => {
    const items = makeItems();
    const out = stratifiedSample(items, (it) => it.category, 0.5, seededRng(99));
    const ids = out.map((it) => it.id);
    const sorted = [...ids].sort((a, b) => a - b);
    expect(ids).toEqual(sorted);
  });

  it("does not mutate the input array", () => {
    const items = makeItems();
    const before = items.map((it) => it.id);
    stratifiedSample(items, (it) => it.category, 0.5, seededRng(1));
    expect(items.map((it) => it.id)).toEqual(before);
  });
});

describe("summariseStrata", () => {
  it("reports before / after / fraction per stratum, sorted alphabetically", () => {
    const items = makeItems();
    const out = stratifiedSample(items, (it) => it.category, 0.5, seededRng(7));
    const summary = summariseStrata(items, out, (it) => it.category);
    expect(summary.map((s) => s.key)).toEqual(["A", "B", "C", "D"]);
    expect(summary[0]).toMatchObject({ key: "A", before: 100, after: 50 });
    expect(summary[0].fraction).toBeCloseTo(0.5, 6);
    expect(summary[3]).toMatchObject({ key: "D", before: 10, after: 5 });
  });
});

function countBy<T>(
  items: readonly T[],
  keyFn: (item: T) => string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = keyFn(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
