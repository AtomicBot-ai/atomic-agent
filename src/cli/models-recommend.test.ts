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
    expect(text).toMatch(/quality\s+gemma-4-26b-a4b/);
    expect(text).toContain("models upgrade");
  });
});

describe("models recommend with experts in RAM (ATO-2455)", () => {
  const machine = {
    ramGb: 32,
    gpuBudgetGb: 8,
    freeDiskGb: 500,
    cpuOnly: false,
    bandwidth: { gpuGbPerSec: 272, ramGbPerSec: 50, unified: false },
  };
  const snap: RecommendSnapshot = {
    machine,
    tiers: recommendModelTiers(machine, { expertsInRam: true }),
    decision: decideModelUpgrade({
      machine,
      activeModelId: null,
      downloadedIds: [],
      managed: true,
      cloudActive: false,
    }),
    activeModelId: null,
  };

  it("marks the tier that runs with experts in RAM and gives its speed estimate", () => {
    const tiers = recommendJson(snap).tiers as Record<
      string,
      { id: string; fitLabel: string; expertsInRam: boolean; speed: string | null } | null
    >;
    expect(tiers.quality).toMatchObject({
      id: "qwen-3.6-35b-a3b",
      fitLabel: "Fits, experts in RAM",
      expertsInRam: true,
    });
    expect(tiers.quality?.speed).toMatch(/tok\/s, estimate$/);
    expect(tiers.fast?.expertsInRam).toBe(false);
  });

  it("says so on the text row", () => {
    expect(describeRecommendation(snap)).toMatch(
      /quality\s+qwen-3\.6-35b-a3b.*\(experts partly in RAM, ~\d+ tok\/s, estimate\)/,
    );
  });
});
