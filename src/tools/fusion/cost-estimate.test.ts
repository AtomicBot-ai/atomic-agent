import { describe, expect, it } from "vitest";
import {
  describeCostEstimate,
  estimateTaskCostUsd,
  OUTPUT_TOKENS_PER_STEP,
  WORKER_FRAME_TOKENS,
} from "./cost-estimate.js";

const pricing = { input: 1, output: 4, cacheRead: 0.1 };

describe("estimateTaskCostUsd", () => {
  it("prices a one-step task: frame + brief in, the output out", () => {
    // 400 brief chars = 100 tokens; 800 output tokens = one step.
    const usd = estimateTaskCostUsd(
      { briefChars: 400, outputTokens: OUTPUT_TOKENS_PER_STEP },
      pricing,
    );
    const input = WORKER_FRAME_TOKENS + 100;
    expect(usd).toBeCloseTo(
      (input / 1e6) * 1 + (OUTPUT_TOKENS_PER_STEP / 1e6) * 4,
      10,
    );
  });

  it("bills repeated steps at the cache-read rate", () => {
    // 1,600 output tokens = 2 steps; base 4,000 + 0 brief.
    const usd = estimateTaskCostUsd({ briefChars: 0, outputTokens: 1_600 }, pricing);
    const base = WORKER_FRAME_TOKENS;
    const prompt = 2 * base + 800; // Σ base + output written before step 2
    const firstSeen = base + 1_600;
    const expected =
      (firstSeen / 1e6) * 1 +
      ((prompt - firstSeen) / 1e6) * 0.1 +
      (1_600 / 1e6) * 4;
    expect(usd).toBeCloseTo(expected, 10);
  });

  it("reads a line estimate as 10 tokens a line", () => {
    expect(
      estimateTaskCostUsd({ briefChars: 0, outputLines: 80 }, pricing),
    ).toBeCloseTo(estimateTaskCostUsd({ briefChars: 0, outputTokens: 800 }, pricing)!, 12);
  });

  it("is null on a local leg or an unpriced model, and without an output estimate", () => {
    expect(estimateTaskCostUsd({ briefChars: 400, outputTokens: 800 }, undefined)).toBeNull();
    expect(estimateTaskCostUsd({ briefChars: 400 }, pricing)).toBeNull();
  });
});

describe("describeCostEstimate", () => {
  it("shows the forecast beside the actual spend", () => {
    expect(describeCostEstimate(0.04, 0.05)).toBe("cost: ≈$0.04 est, $0.05 actual");
    expect(describeCostEstimate(0.004, null)).toBe("cost: ≈$0.0040 est");
  });
});
