import { describe, expect, it } from "vitest";

import { decideModelUpgrade, recommendModelTiers } from "../local-llm/catalog/model-upgrade.js";
import { describeRecommendation, recommendJson, type RecommendSnapshot } from "./models-recommend.js";

function snapshot(activeModelId: string | null): RecommendSnapshot {
  const machine = { ramGb: 32, gpuBudgetGb: 24, freeDiskGb: 120, cpuOnly: false };
  return {
    machine,
    tiers: recommendModelTiers(machine),
    decision: decideModelUpgrade({
      machine,
      activeModelId,
      downloadedIds: ["qwen-3.5-2b"],
      managed: true,
      cloudActive: false,
    }),
    activeModelId,
  };
}

describe("models recommend --json", () => {
  it("keeps the shape the desktop reads", () => {
    const json = recommendJson(snapshot("qwen-3.5-2b"));
    expect(json).toMatchObject({
      version: 1,
      machine: { ramGb: 32, gpuBudgetGb: 24, freeDiskGb: 120, cpuOnly: false },
      activeModelId: "qwen-3.5-2b",
      upgrade: { action: "download", why: null, model: { id: "gemma-4-26b-a4b" } },
    });
    const tiers = json.tiers as Record<string, { id: string; downloadGb: number } | null>;
    expect(Object.keys(tiers)).toEqual(["fast", "balanced", "quality"]);
    expect(tiers.quality?.downloadGb).toBeGreaterThan(14);
    // ATO-1410, additive: the name and both memory figures the desktop shows.
    expect(json.tiers).toMatchObject({
      quality: { displayName: "Gemma 4 26B-A4B", minRamGb: 16, recommendedRamGb: 20 },
    });
  });

  it("says why there is nothing to do", () => {
    expect(recommendJson(snapshot("gemma-4-26b-a4b")).upgrade).toEqual({
      action: "none",
      why: "already_best",
      model: null,
    });
  });
});

describe("models recommend (text)", () => {
  it("names the machine, the three tiers and the next step", () => {
    const text = describeRecommendation(snapshot("qwen-3.5-2b"));
    expect(text).toContain("32 GB RAM");
    expect(text).toMatch(/fast\s+\S+/);
    // ATO-1410: the name and the need the desktop prints; the id stays for `models use`.
    expect(text).toMatch(/quality\s+Gemma 4 26B-A4B\s/);
    expect(text).toContain("needs 20 GB");
    expect(text).toContain("(gemma-4-26b-a4b)");
    expect(text).toContain("models upgrade");
  });
});
