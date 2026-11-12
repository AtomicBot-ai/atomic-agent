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

  // ATO-912: Kimi reports cache writes beside the hits; they are their
  // own share of the prompt and have their own rate.
  it("prices cache-write tokens at the cacheWrite rate when one is known", () => {
    const usd = estimateUsageCostUsd(
      {
        promptTokens: 1_000_000,
        completionTokens: 0,
        totalTokens: 1_000_000,
        cachedTokens: 600_000,
        cacheWriteTokens: 300_000,
      },
      { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
    );
    // 100k uncached at $2 + 600k hits at $0.20 + 300k writes at $4 (1h TTL).
    expect(usd).toBeCloseTo(0.2 + 0.12 + 1.2, 9);
  });

  it("keeps cache writes at the input rate when no cacheWrite rate is known", () => {
    const withWrites = estimateUsageCostUsd(
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cachedTokens: 600_000, cacheWriteTokens: 300_000 },
      { input: 2, output: 10, cacheRead: 0.2 },
    );
    const without = estimateUsageCostUsd(
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cachedTokens: 600_000 },
      { input: 2, output: 10, cacheRead: 0.2 },
    );
    expect(withWrites).toBeCloseTo(without, 9);
  });

  it("never lets cache writes eat into the cached share or past the prompt", () => {
    const usd = estimateUsageCostUsd(
      { promptTokens: 1_000, completionTokens: 0, totalTokens: 1_000, cachedTokens: 800, cacheWriteTokens: 5_000 },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 },
    );
    // Only the 200 tokens left after the hits can be writes.
    expect(usd).toBeCloseTo(200, 9);
  });

  it("never lets a cached count exceed the prompt it is part of", () => {
    const usd = estimateUsageCostUsd(
      { promptTokens: 1_000, completionTokens: 0, totalTokens: 1_000, cachedTokens: 5_000 },
      { input: 1_000_000, output: 0, cacheRead: 0 },
    );
    expect(usd).toBe(0);
  });
});
