import { describe, expect, it } from "vitest";

import {
  buildKvLayout,
  estimateKvBytesPerToken,
  type KvLayoutSource,
} from "./context-size.js";
import { kvLayoutSourceFromMetadata, parseGgufHeader } from "./gguf-metadata.js";
import { encodeSyntheticGguf, gemma4Pairs, densePairs } from "./gguf-metadata.fixtures.js";
import {
  isSwaFullPreference,
  resolveSwaFullDecision,
  SWA_FULL_MAX_RATIO,
} from "./swa-full.js";

const GEMMA: KvLayoutSource = kvLayoutSourceFromMetadata(
  parseGgufHeader(encodeSyntheticGguf(gemma4Pairs())),
)!;
const DENSE: KvLayoutSource = kvLayoutSourceFromMetadata(
  parseGgufHeader(encodeSyntheticGguf(densePairs())),
)!;

const CTX = 131_072;
const gemmaSwaBytes =
  estimateKvBytesPerToken(buildKvLayout(GEMMA), "turbo3", CTX) * CTX;

describe("resolveSwaFullDecision", () => {
  it("is off with no layout and not applicable without sliding layers", () => {
    expect(
      resolveSwaFullDecision({ preference: "on", layout: null, contextSize: CTX, kvBudgetBytes: 1e12 }),
    ).toMatchObject({ enabled: false, estimate: null });
    expect(
      resolveSwaFullDecision({ preference: "on", layout: DENSE, contextSize: CTX, kvBudgetBytes: 1e12 }),
    ).toMatchObject({ enabled: false, slidingLayers: 0 });
  });

  it("estimates full SWA as per-token KV × total / non-sliding layers — ×6 on Gemma 4", () => {
    const decision = resolveSwaFullDecision({
      preference: "auto",
      layout: GEMMA,
      contextSize: CTX,
      kvBudgetBytes: 1e12,
    });
    expect(decision.slidingLayers).toBe(50);
    expect(decision.estimate?.ratio).toBeCloseTo(6, 6);
    expect(decision.estimate?.capped).toBe(false);
    expect(decision.estimate?.swa).toBeCloseTo(gemmaSwaBytes, 0);
    expect(decision.estimate?.full).toBeCloseTo(gemmaSwaBytes * 6, 0);
    expect(decision.reason).toContain("estimate");
  });

  it("honours on and off whatever the budget", () => {
    expect(
      resolveSwaFullDecision({ preference: "off", layout: GEMMA, contextSize: CTX, kvBudgetBytes: 1e12 }),
    ).toMatchObject({ enabled: false });
    expect(
      resolveSwaFullDecision({ preference: "on", layout: GEMMA, contextSize: CTX, kvBudgetBytes: 0 }),
    ).toMatchObject({ enabled: true });
  });

  it("auto: on when the full-SWA estimate fits the KV budget, off when it does not, off with no budget", () => {
    const fits = resolveSwaFullDecision({
      preference: "auto",
      layout: GEMMA,
      contextSize: CTX,
      kvBudgetBytes: gemmaSwaBytes * 6 + 1,
    });
    expect(fits.enabled).toBe(true);
    expect(fits.reason).toMatch(/on \(auto\)/);
    const tight = resolveSwaFullDecision({
      preference: "auto",
      layout: GEMMA,
      contextSize: CTX,
      kvBudgetBytes: gemmaSwaBytes * 6 - 1,
    });
    expect(tight.enabled).toBe(false);
    expect(tight.reason).toMatch(/off \(auto\)/);
    expect(
      resolveSwaFullDecision({ preference: "auto", layout: GEMMA, contextSize: CTX, kvBudgetBytes: null }),
    ).toMatchObject({ enabled: false });
  });

  it("caps the ratio at 8× and says so", () => {
    // One global layer in twelve would put the ratio at 12.
    const pattern = Array.from({ length: 12 }, (_, i) => i !== 11);
    const decision = resolveSwaFullDecision({
      preference: "auto",
      layout: {
        blockCount: 12,
        headCountKv: 4,
        keyLength: 128,
        valueLength: 128,
        slidingWindow: 512,
        slidingWindowPattern: pattern,
      },
      contextSize: 32_768,
      kvBudgetBytes: 1e12,
    });
    expect(decision.estimate?.ratio).toBe(SWA_FULL_MAX_RATIO);
    expect(decision.estimate?.capped).toBe(true);
    expect(decision.reason).toContain("capped");
  });

  it("knows its own preferences", () => {
    expect(isSwaFullPreference("auto")).toBe(true);
    expect(isSwaFullPreference("on")).toBe(true);
    expect(isSwaFullPreference("off")).toBe(true);
    expect(isSwaFullPreference("yes")).toBe(false);
    expect(isSwaFullPreference(true)).toBe(false);
  });
});
