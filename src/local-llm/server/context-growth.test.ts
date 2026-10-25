import { describe, expect, it } from "vitest";

import { USER_CONFIG_DEFAULTS } from "../../config/config-schema.js";
import { effectiveReplyReserve } from "../../prompt/token-budget.js";
import { getLocalModelDef } from "../catalog/models-catalog.js";
import { estimateContextSize, MIN_AUTO_CONTEXT } from "./context-size.js";
import {
  CONTEXT_GROWTH_TRIGGER_SHARE,
  CONTEXT_SIZE_MODEL_MAX,
  GPU_AUTO_MAX_SLOTS,
  GPU_AUTO_START_CONTEXT,
  MANAGED_CONTEXT_SIZE_PRESETS,
  MANAGED_PARALLEL_PRESETS,
  decideContextGrowth,
  resolveGrowingAutoContext,
} from "./context-growth.js";
import { MAX_AUTO_SLOTS, resolveConfiguredSlots, resolveWorkerSlots } from "./worker-slots.js";

const CAP = USER_CONFIG_DEFAULTS.localModels.completionMaxTokens;

/** Free VRAM a 24 GB and a 48 GB card report with the desktop idle. */
const CARD_24GB_FREE_MIB = 23_000;
const CARD_48GB_FREE_MIB = 47_000;

/** What fits a catalogue model on a card, auto-sized (file-size fallback: no header in a unit test). */
function fitOn(modelId: "qwen-3.5-4b" | "qwen-3.8-27b", freeVramMiB: number): number {
  const model = getLocalModelDef(modelId);
  return estimateContextSize({
    freeVramMiB,
    modelSizeGb: model.fileSizeGb,
    mmprojSizeGb: 0,
    maxContextLength: model.maxContextLength,
    configuredContextSize: 0,
  });
}

/** Every window a conversation that keeps filling the prompt walks through, from the start. */
function growthPath(start: { contextSize: number; ceiling: number }): number[] {
  const path = [start.contextSize];
  let current = start.contextSize;
  for (let turn = 0; turn < 20; turn += 1) {
    const next = decideContextGrowth({
      currentContext: current,
      ceiling: start.ceiling,
      promptTokens: current, // a full window: always past the trigger
      replyReserveTokens: effectiveReplyReserve(CAP, current),
    });
    if (next === null) break;
    expect(next).toBeLessThanOrEqual(current * 2);
    path.push(next);
    current = next;
  }
  return path;
}

describe("GPU_AUTO_START_CONTEXT", () => {
  it("is the auto-size floor: the smallest window the agent works in", () => {
    expect(GPU_AUTO_START_CONTEXT).toBe(MIN_AUTO_CONTEXT);
    expect(GPU_AUTO_START_CONTEXT).toBe(32_768);
  });
});

describe("resolveGrowingAutoContext on a dedicated GPU", () => {
  for (const [label, free] of [["24 GB", CARD_24GB_FREE_MIB], ["48 GB", CARD_48GB_FREE_MIB]] as const) {
    for (const modelId of ["qwen-3.5-4b", "qwen-3.8-27b"] as const) {
      it(`${modelId} on a ${label} card starts at ${GPU_AUTO_START_CONTEXT}, and the fit is the ceiling`, () => {
        const fit = fitOn(modelId, free);
        const start = resolveGrowingAutoContext({ fitContext: fit });
        expect(start.contextSize).toBeLessThanOrEqual(GPU_AUTO_START_CONTEXT);
        expect(start.contextSize).toBe(Math.min(fit, GPU_AUTO_START_CONTEXT));
        expect(start.ceiling).toBe(fit);
      });
    }
  }

  it("holds qwen-3.8-27b on 24 GB to its fit, and lets 48 GB and the 4B reach the trained 262,144", () => {
    expect(fitOn("qwen-3.8-27b", CARD_24GB_FREE_MIB)).toBe(60_416);
    expect(fitOn("qwen-3.8-27b", CARD_48GB_FREE_MIB)).toBe(262_144);
    expect(fitOn("qwen-3.5-4b", CARD_24GB_FREE_MIB)).toBe(262_144);
  });

  it("restarts bigger when asked, never past the fit, never below the start", () => {
    expect(resolveGrowingAutoContext({ fitContext: 262_144, atLeast: 65_536 }).contextSize).toBe(65_536);
    expect(resolveGrowingAutoContext({ fitContext: 60_416, atLeast: 65_536 }).contextSize).toBe(60_416);
    expect(resolveGrowingAutoContext({ fitContext: 262_144, atLeast: 1_000 }).contextSize).toBe(32_768);
    expect(resolveGrowingAutoContext({ fitContext: 262_144, atLeast: 70_000 }).contextSize).toBe(69_632);
    // A model trained shorter than the start window keeps its own ceiling.
    expect(resolveGrowingAutoContext({ fitContext: 8_192 }).contextSize).toBe(8_192);
  });
});

describe("decideContextGrowth", () => {
  it("doubles up to the ceiling as the conversation fills the window: 48 GB, qwen-3.8-27b", () => {
    const start = resolveGrowingAutoContext({ fitContext: fitOn("qwen-3.8-27b", CARD_48GB_FREE_MIB) });
    expect(growthPath(start)).toEqual([32_768, 65_536, 131_072, 262_144]);
  });

  it("stops at what fits: 24 GB, qwen-3.8-27b", () => {
    const start = resolveGrowingAutoContext({ fitContext: fitOn("qwen-3.8-27b", CARD_24GB_FREE_MIB) });
    expect(growthPath(start)).toEqual([32_768, 60_416]);
  });

  it("doubles the 4B the same way on 24 GB", () => {
    const start = resolveGrowingAutoContext({ fitContext: fitOn("qwen-3.5-4b", CARD_24GB_FREE_MIB) });
    expect(growthPath(start)).toEqual([32_768, 65_536, 131_072, 262_144]);
  });

  it("grows only past three quarters of the prompt's room (the window less the reply reserve)", () => {
    // 32,768 with the default 16,384 reply cap: the reserve is half the
    // window, so the prompt has 16,384 and the trigger is past 12,288.
    const reserve = effectiveReplyReserve(CAP, 32_768);
    expect(reserve).toBe(16_384);
    const at = (promptTokens: number) =>
      decideContextGrowth({ currentContext: 32_768, ceiling: 262_144, promptTokens, replyReserveTokens: reserve });
    expect(at(7_500)).toBeNull();
    expect(at((32_768 - reserve) * CONTEXT_GROWTH_TRIGGER_SHARE)).toBeNull();
    expect(at(12_289)).toBe(65_536);
  });

  it("takes one step per call, even for a conversation that has outgrown several", () => {
    expect(
      decideContextGrowth({ currentContext: 32_768, ceiling: 262_144, promptTokens: 200_000, replyReserveTokens: 16_384 }),
    ).toBe(65_536);
  });

  it("never grows a launch that does not grow, or one already at its ceiling", () => {
    const base = { currentContext: 32_768, promptTokens: 30_000, replyReserveTokens: 16_384 };
    expect(decideContextGrowth({ ...base, ceiling: null })).toBeNull();
    expect(decideContextGrowth({ ...base, ceiling: undefined })).toBeNull();
    expect(decideContextGrowth({ ...base, ceiling: 32_768 })).toBeNull();
    expect(decideContextGrowth({ ...base, currentContext: 262_144, ceiling: 262_144, promptTokens: 250_000 })).toBeNull();
    expect(decideContextGrowth({ ...base, promptTokens: 0 })).toBeNull();
  });
});

describe("auto slots on a growing launch", () => {
  it("are held to two however far the window grows; the ungrown fit would have had eight", () => {
    for (const ctx of [32_768, 65_536, 131_072, 262_144]) {
      expect(
        resolveWorkerSlots({ contextSize: ctx, cpuOnly: false, completionMaxTokens: CAP, maxSlots: GPU_AUTO_MAX_SLOTS }),
      ).toBeLessThanOrEqual(GPU_AUTO_MAX_SLOTS);
    }
    expect(resolveWorkerSlots({ contextSize: 32_768, cpuOnly: false, completionMaxTokens: CAP, maxSlots: GPU_AUTO_MAX_SLOTS })).toBe(1);
    expect(resolveWorkerSlots({ contextSize: 262_144, cpuOnly: false, completionMaxTokens: CAP })).toBe(MAX_AUTO_SLOTS);
  });

  it("never cap a pinned parallel", () => {
    expect(
      resolveConfiguredSlots(4, { contextSize: 32_768, cpuOnly: false, maxSlots: GPU_AUTO_MAX_SLOTS }),
    ).toBe(4);
  });
});

describe("the manual choices (ATO-336)", () => {
  it("offers Auto, 32K, 64K, 128K and the model's maximum for the context", () => {
    expect(MANAGED_CONTEXT_SIZE_PRESETS).toEqual([0, 32_768, 65_536, 131_072, CONTEXT_SIZE_MODEL_MAX]);
  });

  it("pins a manual context uncapped: 128K and the model maximum land on what the operator chose", () => {
    const model = getLocalModelDef("qwen-3.8-27b");
    const pinned = (configuredContextSize: number) =>
      estimateContextSize({
        freeVramMiB: CARD_24GB_FREE_MIB,
        modelSizeGb: model.fileSizeGb,
        mmprojSizeGb: 0,
        maxContextLength: model.maxContextLength,
        configuredContextSize,
      });
    expect(pinned(131_072)).toBe(131_072);
    expect(pinned(CONTEXT_SIZE_MODEL_MAX)).toBe(model.maxContextLength);
  });

  it("offers Auto, 1, 2 and 4 for the request slots", () => {
    expect(MANAGED_PARALLEL_PRESETS).toEqual(["auto", 1, 2, 4]);
  });
});
