import { describe, expect, it } from "vitest";

import {
  computeStepComplexity,
  type StepComplexitySignals,
} from "./compute-step-complexity.js";

const base: StepComplexitySignals = {
  promptTokens: 0,
  stablePrefixTokens: 0,
  stepIndex: 0,
  maxSteps: 25,
  conversationMaxTokens: 32_000,
  hasTransientNotice: false,
};

const at = (over: Partial<StepComplexitySignals>): number =>
  computeStepComplexity({ ...base, ...over });

describe("computeStepComplexity", () => {
  it("scores a fresh, empty step at zero", () => {
    expect(at({})).toBe(0);
  });

  it("saturates at 100 when every signal is maxed", () => {
    expect(
      at({
        promptTokens: 64_000,
        stablePrefixTokens: 0,
        stepIndex: 25,
        hasTransientNotice: true,
      }),
    ).toBe(100);
  });

  it("always returns an integer inside 0-100", () => {
    const samples = [
      at({ promptTokens: 7_777, stablePrefixTokens: 1_234, stepIndex: 3 }),
      at({ promptTokens: 31_999, stablePrefixTokens: 12_001, stepIndex: 7 }),
      at({ promptTokens: 1, stablePrefixTokens: 0, stepIndex: 1 }),
    ];
    for (const score of samples) {
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it("is monotonic in context pressure", () => {
    const low = at({ promptTokens: 4_000, stablePrefixTokens: 4_000 });
    const high = at({ promptTokens: 16_000, stablePrefixTokens: 16_000 });
    expect(high).toBeGreaterThan(low);
  });

  it("is monotonic in turn depth", () => {
    expect(at({ stepIndex: 12 })).toBeGreaterThan(at({ stepIndex: 2 }));
  });

  it("is monotonic in tail growth at a fixed prompt size", () => {
    const mostlyStable = at({ promptTokens: 20_000, stablePrefixTokens: 19_000 });
    const mostlyTail = at({ promptTokens: 20_000, stablePrefixTokens: 1_000 });
    expect(mostlyTail).toBeGreaterThan(mostlyStable);
  });

  it("adds exactly the transient-notice weight", () => {
    const quiet = at({ promptTokens: 8_000, stablePrefixTokens: 6_000 });
    const noisy = at({
      promptTokens: 8_000,
      stablePrefixTokens: 6_000,
      hasTransientNotice: true,
    });
    expect(noisy - quiet).toBe(20);
  });

  it("treats a tail larger than the prompt as zero, never negative", () => {
    expect(at({ promptTokens: 100, stablePrefixTokens: 5_000 })).toBe(0);
  });

  it("survives zero and non-finite budgets without producing NaN", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const score = at({
        promptTokens: 10_000,
        conversationMaxTokens: bad,
        maxSteps: bad,
        stepIndex: 5,
      });
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
    }
  });
});
