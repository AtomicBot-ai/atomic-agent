import { describe, expect, it } from "vitest";

import { USER_CONFIG_DEFAULTS } from "../../config/config-schema.js";
import { effectiveReplyReserve } from "../../prompt/token-budget.js";
import { getLocalModelDef } from "../catalog/models-catalog.js";
import { estimateContextSize, MIN_AUTO_CONTEXT } from "./context-size.js";
import {
  CONTEXT_GROWTH_TRIGGER_SHARE,
  CONTEXT_SIZE_MODEL_MAX,
  GPU_AUTO_MAX_CONTEXT,
  GPU_AUTO_MAX_SLOTS,
  GPU_AUTO_START_CONTEXT,
  GPU_GROWING_MAX_SLOTS,
  decideContextGrowth,
  resolveDedicatedGpuAutoContext,
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
function growthPath(start: { contextSize: number; ceiling: number | null }): number[] {
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

describe("resolveDedicatedGpuAutoContext", () => {
  for (const [label, free] of [["24 GB", CARD_24GB_FREE_MIB], ["48 GB", CARD_48GB_FREE_MIB]] as const) {
    for (const modelId of ["qwen-3.5-4b", "qwen-3.8-27b"] as const) {
      it(`${modelId} on a ${label} card, growable: starts at ${GPU_AUTO_START_CONTEXT}, the ceiling at most ${GPU_AUTO_MAX_CONTEXT}`, () => {
        const fit = fitOn(modelId, free);
        const start = resolveDedicatedGpuAutoContext({ fitContext: fit, growable: true });
        expect(start.contextSize).toBeLessThanOrEqual(GPU_AUTO_START_CONTEXT);
        expect(start.contextSize).toBe(Math.min(fit, GPU_AUTO_START_CONTEXT));
        expect(start.ceiling).toBe(Math.min(fit, GPU_AUTO_MAX_CONTEXT));
        expect(start.maxSlots).toBe(GPU_GROWING_MAX_SLOTS);
      });

      it(`${modelId} on a ${label} card, not growable: the fit, at most ${GPU_AUTO_MAX_CONTEXT}, no ceiling`, () => {
        const fit = fitOn(modelId, free);
        const launch = resolveDedicatedGpuAutoContext({ fitContext: fit, growable: false });
        expect(launch.contextSize).toBe(Math.min(fit, GPU_AUTO_MAX_CONTEXT));
        expect(launch.contextSize).toBeLessThanOrEqual(131_072);
        expect(launch.ceiling).toBeNull();
        expect(launch.maxSlots).toBe(GPU_AUTO_MAX_SLOTS);
      });
    }
  }

  it("holds qwen-3.8-27b on 24 GB to its fit; 48 GB and the 4B would fit the trained 262,144", () => {
    expect(fitOn("qwen-3.8-27b", CARD_24GB_FREE_MIB)).toBe(60_416);
    expect(fitOn("qwen-3.8-27b", CARD_48GB_FREE_MIB)).toBe(262_144);
    expect(fitOn("qwen-3.5-4b", CARD_24GB_FREE_MIB)).toBe(262_144);
  });

  it("restarts bigger when asked, never past the ceiling, never below the start; ignores it when not growable", () => {
    const grow = (fitContext: number, atLeast?: number) =>
      resolveDedicatedGpuAutoContext({ fitContext, growable: true, atLeast: atLeast ?? null }).contextSize;
    expect(grow(262_144, 65_536)).toBe(65_536);
    expect(grow(262_144, 262_144)).toBe(131_072);
    expect(grow(60_416, 65_536)).toBe(60_416);
    expect(grow(262_144, 1_000)).toBe(32_768);
    expect(grow(262_144, 70_000)).toBe(69_632);
    // A model trained shorter than the start window keeps its own ceiling.
    expect(grow(8_192)).toBe(8_192);
    expect(
      resolveDedicatedGpuAutoContext({ fitContext: 262_144, growable: false, atLeast: 32_768 }).contextSize,
    ).toBe(131_072);
  });
});

describe("decideContextGrowth", () => {
  it("doubles up to the ceiling as the conversation fills the window: 48 GB, qwen-3.8-27b", () => {
    const start = resolveDedicatedGpuAutoContext({ fitContext: fitOn("qwen-3.8-27b", CARD_48GB_FREE_MIB), growable: true });
    expect(growthPath(start)).toEqual([32_768, 65_536, 131_072]);
  });

  it("stops at what fits: 24 GB, qwen-3.8-27b", () => {
    const start = resolveDedicatedGpuAutoContext({ fitContext: fitOn("qwen-3.8-27b", CARD_24GB_FREE_MIB), growable: true });
    expect(growthPath(start)).toEqual([32_768, 60_416]);
  });

  it("doubles the 4B the same way on 24 GB", () => {
    const start = resolveDedicatedGpuAutoContext({ fitContext: fitOn("qwen-3.5-4b", CARD_24GB_FREE_MIB), growable: true });
    expect(growthPath(start)).toEqual([32_768, 65_536, 131_072]);
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
    expect(decideContextGrowth({ ...base, ceiling: 262_144, promptTokens: 0 })).toBeNull();
  });
});

describe("auto slots on a GPU with its own memory", () => {
  const slots = (contextSize: number, maxSlots?: number, localLegRole?: "workers" | "orchestrator") =>
    resolveWorkerSlots({
      contextSize,
      cpuOnly: false,
      completionMaxTokens: CAP,
      ...(maxSlots === undefined ? {} : { maxSlots }),
      ...(localLegRole === undefined ? {} : { localLegRole }),
    });

  it("a growable launch keeps at most two however far it grows", () => {
    for (const ctx of [32_768, 65_536, 131_072]) {
      expect(slots(ctx, GPU_GROWING_MAX_SLOTS)).toBeLessThanOrEqual(GPU_GROWING_MAX_SLOTS);
    }
    expect(slots(32_768, GPU_GROWING_MAX_SLOTS)).toBe(1);
  });

  it("Fusion's local workers on a launch nobody grows get four, not one; the uncapped window had eight", () => {
    const window = resolveDedicatedGpuAutoContext({ fitContext: 262_144, growable: false });
    expect(slots(window.contextSize, window.maxSlots, "workers")).toBe(4);
    expect(slots(262_144)).toBe(MAX_AUTO_SLOTS);
  });

  it("never cap a pinned parallel", () => {
    expect(
      resolveConfiguredSlots(8, { contextSize: 32_768, cpuOnly: false, maxSlots: GPU_AUTO_MAX_SLOTS }),
    ).toBe(8);
  });
});

describe("the manual choices (ATO-336)", () => {
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
});
