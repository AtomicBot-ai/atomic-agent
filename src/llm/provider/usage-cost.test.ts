import { describe, expect, it } from "vitest";

import { estimateUsageCostUsd } from "./usage-cost.js";

describe("estimateUsageCostUsd", () => {
  it("prices cached prompt tokens at the cacheRead rate", () => {
    const usd = estimateUsageCostUsd(
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cachedTokens: 800_000 },
      { input: 3, output: 15, cacheRead: 0.3 },
    );
    // 200k uncached at $3/M + 800k cached at $0.30/M.
    expect(usd).toBeCloseTo(0.6 + 0.24, 9);
  });

  it("charges the plain input rate when no cacheRead rate is known", () => {
    const usd = estimateUsageCostUsd(
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cachedTokens: 800_000 },
      { input: 3, output: 15 },
    );
    expect(usd).toBeCloseTo(3, 9);
  });

  it("is the historical formula when nothing was cached", () => {
    const usd = estimateUsageCostUsd(
      { promptTokens: 500_000, completionTokens: 100_000, totalTokens: 600_000 },
      { input: 2, output: 10, cacheRead: 0.2 },
    );
    expect(usd).toBeCloseTo(1 + 1, 9);
  });

  it("never lets a cached count exceed the prompt it is part of", () => {
    const usd = estimateUsageCostUsd(
      { promptTokens: 1_000, completionTokens: 0, totalTokens: 1_000, cachedTokens: 5_000 },
      { input: 1_000_000, output: 0, cacheRead: 0 },
    );
    expect(usd).toBe(0);
  });
});
