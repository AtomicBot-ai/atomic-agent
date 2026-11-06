import { describe, expect, it } from "vitest";

import {
  CPU_ONLY_MAX_MODEL_GB,
  decideModelUpgrade,
  modelsThisMachineCarries,
  recommendModelTiers,
  type MachineForModels,
} from "./model-upgrade.js";
import { STARTER_LOCAL_MODEL_ID } from "./models-catalog.js";

function mac(ramGb: number, freeDiskGb: number | null = 500): MachineForModels {
  return { ramGb, gpuBudgetGb: ramGb * 0.75, freeDiskGb, cpuOnly: false };
}

describe("recommendModelTiers (curated catalog)", () => {
  it.each([
    // RAM, quality tier: the catalog's own rank order (#852) under the GPU share.
    [8, "qwen-3.5-4b"],
    [16, "qwen-3.5-9b"],
    [32, "gemma-4-26b-a4b"],
    [64, "qwen-3.6-35b-a3b"],
  ])("a %i GB Mac gets %s as the quality tier", (ram, id) => {
    expect(recommendModelTiers(mac(ram)).quality?.id).toBe(id);
  });

  it("keeps the balanced tier under the first-run download ceiling", () => {
    const tiers = recommendModelTiers(mac(64));
    expect(tiers.balanced).not.toBeNull();
    expect(tiers.balanced!.fileSizeGb).toBeLessThanOrEqual(8);
    expect(tiers.fast!.fileSizeGb).toBeLessThanOrEqual(tiers.balanced!.fileSizeGb);
  });

  it("never names the starter or an uncensored entry", () => {
    const carried = modelsThisMachineCarries(mac(128));
    expect(carried.map((d) => d.id)).not.toContain(STARTER_LOCAL_MODEL_ID);
    expect(carried.some((d) => d.uncensored === true)).toBe(false);
  });

  it("drops models that do not fit the discrete GPU", () => {
    // 64 GB of RAM but an 8 GB card: the 22 GB models would crawl.
    const pc: MachineForModels = { ramGb: 64, gpuBudgetGb: 8, freeDiskGb: 500, cpuOnly: false };
    const q = recommendModelTiers(pc).quality!;
    expect(q.fileSizeGb).toBeLessThanOrEqual(8 * 0.85);
  });

  it("caps a CPU-only machine at mid-size weights", () => {
    const pc: MachineForModels = { ramGb: 64, gpuBudgetGb: null, freeDiskGb: 500, cpuOnly: true };
    const q = recommendModelTiers(pc).quality!;
    expect(q.fileSizeGb).toBeLessThanOrEqual(CPU_ONLY_MAX_MODEL_GB);
  });

  it("skips what the disk cannot hold", () => {
    const q = recommendModelTiers(mac(64, 10)).quality!;
    expect(q.fileSizeGb + 2).toBeLessThanOrEqual(10);
  });

  it("returns nothing on a machine nothing runs on", () => {
    expect(recommendModelTiers(mac(2))).toEqual({ fast: null, balanced: null, quality: null });
  });
});

describe("decideModelUpgrade", () => {
  const base = {
    machine: mac(32),
    downloadedIds: [STARTER_LOCAL_MODEL_ID],
    managed: true,
    cloudActive: false,
  };

  it("downloads the big model behind the starter", () => {
    const d = decideModelUpgrade({ ...base, activeModelId: STARTER_LOCAL_MODEL_ID });
    expect(d).toMatchObject({ action: "download", model: { id: "gemma-4-26b-a4b" } });
  });

  it("offers the switch when the big model is already on disk", () => {
    const d = decideModelUpgrade({
      ...base,
      activeModelId: STARTER_LOCAL_MODEL_ID,
      downloadedIds: [STARTER_LOCAL_MODEL_ID, "gemma-4-26b-a4b"],
    });
    expect(d).toMatchObject({ action: "switch", model: { id: "gemma-4-26b-a4b" } });
  });

  it("downloads when no model is active yet", () => {
    expect(decideModelUpgrade({ ...base, activeModelId: null }).action).toBe("download");
  });

  it("leaves the best model alone", () => {
    expect(decideModelUpgrade({ ...base, activeModelId: "gemma-4-26b-a4b" })).toEqual({
      action: "none",
      why: "already_best",
    });
  });

  it("never moves down from a better-ranked model", () => {
    // qwen-3.6-35b-a3b ranks 1; this 32 GB machine's best ranks 2.
    expect(decideModelUpgrade({ ...base, activeModelId: "qwen-3.6-35b-a3b" }).action).toBe("none");
  });

  it("moves up from a lower-ranked model", () => {
    expect(decideModelUpgrade({ ...base, activeModelId: "qwen-3.5-4b" }).action).toBe("download");
  });

  it("leaves a model the person added themselves", () => {
    expect(decideModelUpgrade({ ...base, activeModelId: "custom-some-repo-q4" })).toEqual({
      action: "none",
      why: "own_choice",
    });
    expect(decideModelUpgrade({ ...base, activeModelId: "nemotron-3.5-30b-a3b" })).toEqual({
      action: "none",
      why: "own_choice",
    });
  });

  it("does nothing for a cloud route or an external server", () => {
    expect(decideModelUpgrade({ ...base, activeModelId: null, cloudActive: true })).toEqual({
      action: "none",
      why: "not_wanted",
    });
    expect(decideModelUpgrade({ ...base, activeModelId: null, managed: false })).toEqual({
      action: "none",
      why: "not_managed",
    });
  });

  it("says nothing fits on a tiny machine", () => {
    expect(
      decideModelUpgrade({ ...base, machine: mac(2), activeModelId: STARTER_LOCAL_MODEL_ID }),
    ).toEqual({ action: "none", why: "nothing_fits" });
  });
});
