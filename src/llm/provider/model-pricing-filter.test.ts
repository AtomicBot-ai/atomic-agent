import { describe, expect, it } from "vitest";
import {
  filterIdsByPricing,
  isFreeModelEntry,
  matchesModelPricingFilter,
  nextModelPricingFilter,
} from "./model-pricing-filter.js";
import type { ModelCatalogEntry } from "./model-resolver.js";

function chatEntry(
  id: string,
  pricing?: { input: number; output: number },
): ModelCatalogEntry {
  return {
    id,
    kind: "chat",
    contextWindow: 128_000,
    supportsVision: false,
    supportsTools: "parallel",
    supportsPromptCache: false,
    reasoningFormat: "none",
    ...(pricing ? { pricing } : {}),
  };
}

describe("nextModelPricingFilter", () => {
  it("cycles all → free → paid → all", () => {
    expect(nextModelPricingFilter("all")).toBe("free");
    expect(nextModelPricingFilter("free")).toBe("paid");
    expect(nextModelPricingFilter("paid")).toBe("all");
  });
});

describe("isFreeModelEntry", () => {
  it("is true only when the catalog proves both prices are zero", () => {
    expect(isFreeModelEntry("v/free", chatEntry("v/free", { input: 0, output: 0 }))).toBe(true);
    expect(isFreeModelEntry("v/paid", chatEntry("v/paid", { input: 0.3, output: 2.5 }))).toBe(false);
    // Output-only pricing is still a price.
    expect(isFreeModelEntry("v/out", chatEntry("v/out", { input: 0, output: 1 }))).toBe(false);
  });

  it("treats missing pricing as not-free (aimlapi rows, live /v1/models ids)", () => {
    expect(isFreeModelEntry("v/unknown", chatEntry("v/unknown"))).toBe(false);
    expect(isFreeModelEntry("v/unknown", undefined)).toBe(false);
  });

  it("keeps openrouter/auto out of free: its tag reads 'routed', and it bills the routed model", () => {
    const auto = chatEntry("openrouter/auto", { input: 0, output: 0 });
    expect(isFreeModelEntry("openrouter/auto", auto)).toBe(false);
  });
});

describe("matchesModelPricingFilter", () => {
  const free = chatEntry("v/free", { input: 0, output: 0 });
  const paid = chatEntry("v/paid", { input: 0.3, output: 2.5 });

  it("'all' keeps every row", () => {
    expect(matchesModelPricingFilter("all", "v/free", free)).toBe(true);
    expect(matchesModelPricingFilter("all", "v/paid", paid)).toBe(true);
    expect(matchesModelPricingFilter("all", "v/unknown", undefined)).toBe(true);
  });

  it("free and paid partition the catalog, so no row vanishes from both", () => {
    expect(matchesModelPricingFilter("free", "v/free", free)).toBe(true);
    expect(matchesModelPricingFilter("paid", "v/free", free)).toBe(false);
    expect(matchesModelPricingFilter("free", "v/paid", paid)).toBe(false);
    expect(matchesModelPricingFilter("paid", "v/paid", paid)).toBe(true);
    // A row with no metadata cannot be promised free; it stays in paid.
    expect(matchesModelPricingFilter("free", "v/unknown", undefined)).toBe(false);
    expect(matchesModelPricingFilter("paid", "v/unknown", undefined)).toBe(true);
  });
});

describe("filterIdsByPricing", () => {
  const entries = new Map<string, ModelCatalogEntry>([
    ["v/free", chatEntry("v/free", { input: 0, output: 0 })],
    ["v/paid", chatEntry("v/paid", { input: 0.3, output: 2.5 })],
  ]);
  const lookup = (id: string): ModelCatalogEntry | undefined => entries.get(id);
  const ids = ["v/free", "v/paid", "v/unknown"] as const;

  it("returns the input array itself for 'all'", () => {
    expect(filterIdsByPricing(ids, "all", lookup)).toBe(ids);
  });

  it("narrows to the facet through the lookup", () => {
    expect(filterIdsByPricing(ids, "free", lookup)).toEqual(["v/free"]);
    expect(filterIdsByPricing(ids, "paid", lookup)).toEqual(["v/paid", "v/unknown"]);
  });

  it("without a lookup nothing is provably free", () => {
    expect(filterIdsByPricing(ids, "free", undefined)).toEqual([]);
    expect(filterIdsByPricing(ids, "paid", undefined)).toEqual([...ids]);
  });
});
