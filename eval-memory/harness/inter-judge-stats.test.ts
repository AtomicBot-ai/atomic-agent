import { describe, it, expect } from "vitest";

import {
  exactAgreement,
  withinOneAgreement,
  cohenKappa,
  confusionMatrix,
  buildInterJudgeReport,
} from "./inter-judge-stats.js";

describe("exactAgreement", () => {
  it("returns 1 when raters are identical", () => {
    expect(exactAgreement([1, 2, 3], [1, 2, 3])).toBe(1);
  });

  it("returns 0 when raters never agree", () => {
    expect(exactAgreement([1, 2, 3], [2, 3, 4])).toBe(0);
  });

  it("returns the matching fraction otherwise", () => {
    expect(exactAgreement([1, 2, 3, 4], [1, 5, 3, 1])).toBe(0.5);
  });

  it("returns 0 on empty input", () => {
    expect(exactAgreement([], [])).toBe(0);
  });

  it("throws on length mismatch", () => {
    expect(() => exactAgreement([1, 2], [1])).toThrow();
  });
});

describe("withinOneAgreement", () => {
  it("counts ±1 disagreements as agreements", () => {
    expect(withinOneAgreement([3, 3, 3], [2, 3, 4])).toBe(1);
  });

  it("rejects gaps > 1", () => {
    expect(withinOneAgreement([1, 1, 1], [3, 3, 3])).toBe(0);
  });
});

describe("confusionMatrix", () => {
  it("counts each (a,b) pair into the correct cell", () => {
    const m = confusionMatrix([1, 2, 2, 3], [1, 2, 3, 3], 5);
    expect(m[0][0]).toBe(1); // (1,1)
    expect(m[1][1]).toBe(1); // (2,2)
    expect(m[1][2]).toBe(1); // (2,3)
    expect(m[2][2]).toBe(1); // (3,3)
  });

  it("rejects out-of-range scores", () => {
    expect(() => confusionMatrix([0], [1], 5)).toThrow();
    expect(() => confusionMatrix([6], [1], 5)).toThrow();
  });
});

describe("cohenKappa (unweighted)", () => {
  it("returns 1 for identical raters", () => {
    expect(cohenKappa([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], 5)).toBeCloseTo(1, 10);
  });

  it("returns 0 for completely uncorrelated raters on a single level", () => {
    // both raters say "3" every time → po=1, pe=1 → undefined → 0
    expect(cohenKappa([3, 3, 3], [3, 3, 3], 5)).toBe(0);
  });

  it("returns ~1 when both raters always disagree by predictable amount", () => {
    // perfect agreement → kappa = 1
    expect(cohenKappa([1, 2, 3, 4, 5, 1, 2, 3], [1, 2, 3, 4, 5, 1, 2, 3], 5)).toBeCloseTo(
      1,
      10,
    );
  });

  it("is negative when raters anti-correlate", () => {
    // A always 1, B always 5 → pe small, po=0 → kappa < 0
    const k = cohenKappa([1, 1, 1, 1], [5, 5, 5, 5], 5);
    expect(k).toBeLessThanOrEqual(0);
  });
});

describe("cohenKappa (quadratic)", () => {
  it("returns 1 for identical raters", () => {
    expect(
      cohenKappa([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], 5, "quadratic"),
    ).toBeCloseTo(1, 10);
  });

  it("is greater than unweighted κ when off-by-one disagreements dominate", () => {
    const a = [1, 2, 3, 4, 5, 1, 2, 3];
    const b = [2, 3, 4, 5, 4, 2, 3, 4]; // shift by 1 (small disagreement)
    const kU = cohenKappa(a, b, 5, "unweighted");
    const kQ = cohenKappa(a, b, 5, "quadratic");
    expect(kQ).toBeGreaterThan(kU);
  });

  it("penalises far-off disagreements more than near-off (with spread marginals)", () => {
    const a = [1, 2, 3, 4, 5];
    const nearOff = [2, 1, 4, 3, 5]; // adjacent swaps → mostly distance 1
    const farOff = [5, 4, 3, 2, 1]; // reverse → distances 4,2,0,2,4
    const kNear = cohenKappa(a, nearOff, 5, "quadratic");
    const kFar = cohenKappa(a, farOff, 5, "quadratic");
    expect(kNear).toBeGreaterThan(kFar);
  });
});

describe("buildInterJudgeReport", () => {
  it("returns all four metrics + n in a single shape", () => {
    const r = buildInterJudgeReport([1, 2, 3, 4, 5], [1, 2, 3, 5, 4], 5);
    expect(r.n).toBe(5);
    expect(r.exactAgreement).toBeCloseTo(0.6, 10);
    expect(r.withinOneAgreement).toBeCloseTo(1, 10);
    expect(r.cohenKappaQuadratic).toBeGreaterThan(r.cohenKappaUnweighted);
  });
});
