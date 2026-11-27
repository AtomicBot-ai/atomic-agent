import { describe, expect, it } from "vitest";

import { kvLayoutSourceFromMetadata, parseGgufHeader } from "../catalog/gguf-metadata.js";
import { encodeSyntheticGguf, qwen36_35bA3bPairs } from "../catalog/gguf-metadata.fixtures.js";
import { buildKvLayout, estimateLaunchKvBytes, MIN_AUTO_CONTEXT } from "./context-size.js";
import { decideCpuMoeLayers, type MoeShape } from "./cpu-moe.js";
import { CPU_MOE_AUTO_CONTEXT, cpuMoeContextRefit } from "./cpu-moe-context.js";
import { resolveEffectiveContextSize } from "./daemon-lifecycle.js";

/** Qwen 3.6 35B-A3B's 40 layers, ~0.5 GB of experts each (estimate). */
const SHAPE: MoeShape = { blockCount: 40, leadingDenseLayers: 0, expertCount: 256, expertBytesPerLayer: 0.5e9 };

const BASE = {
  preference: "auto" as const,
  shape: SHAPE,
  firstPassLayers: 12,
  configuredContext: 0,
  contextSize: MIN_AUTO_CONTEXT,
};

describe("cpuMoeContextRefit", () => {
  it("fits the window again with every MoE layer's experts off the GPU, held to 64K", () => {
    expect(cpuMoeContextRefit(BASE)).toEqual({ offDeviceGb: 20, atMost: CPU_MOE_AUTO_CONTEXT });
  });

  it("does not count leading dense layers as experts", () => {
    expect(cpuMoeContextRefit({ ...BASE, shape: { ...SHAPE, leadingDenseLayers: 4 } })?.offDeviceGb).toBe(18);
  });

  it("leaves a pinned count, off, a pinned window, a dense model and a model that fits alone", () => {
    expect(cpuMoeContextRefit({ ...BASE, preference: 16 })).toBeNull();
    expect(cpuMoeContextRefit({ ...BASE, preference: "off" })).toBeNull();
    expect(cpuMoeContextRefit({ ...BASE, configuredContext: 32_768 })).toBeNull();
    expect(cpuMoeContextRefit({ ...BASE, shape: null })).toBeNull();
    expect(cpuMoeContextRefit({ ...BASE, firstPassLayers: 0 })).toBeNull();
  });

  it("leaves a window already at the ceiling", () => {
    expect(cpuMoeContextRefit({ ...BASE, contextSize: CPU_MOE_AUTO_CONTEXT })).toBeNull();
  });
});

describe("the window after experts go to RAM (startDaemon's two fits)", () => {
  const CARD_8GB = { id: "CUDA0", description: "NVIDIA GeForce RTX 4060", totalMemMiB: 8_188, freeMemMiB: 7_800 };
  const MODEL = { fileSizeGb: 22.4, maxContextLength: 262_144 };
  const source = kvLayoutSourceFromMetadata(parseGgufHeader(encodeSyntheticGguf(qwen36_35bA3bPairs())));
  if (!source) throw new Error("fixture header has no layout");
  const fitOpts = {
    configured: 0,
    hasMmproj: false,
    kvLayout: source,
    listDevices: async () => [CARD_8GB],
  };
  const kvBytes = (contextSize: number) =>
    estimateLaunchKvBytes({ kvLayout: buildKvLayout(source), modelSizeGb: MODEL.fileSizeGb, contextSize, swaFull: false });

  it("gets a bigger window than the floor, and the experts are decided for it", async () => {
    const first = await resolveEffectiveContextSize(CARD_8GB.id, MODEL, fitOpts);
    // 22.4 GB on an 8 GB card: the weights overflow, the window is the floor.
    expect(first.contextSize).toBe(MIN_AUTO_CONTEXT);
    const decide = (contextSize: number) =>
      decideCpuMoeLayers({
        preference: "auto",
        shape: SHAPE,
        device: CARD_8GB.id,
        sharesSystemMemory: first.sharesSystemMemory,
        deviceBudgetBytes: first.deviceBudgetBytes,
        kvBytes: kvBytes(contextSize),
      }).layers;
    const firstLayers = decide(first.contextSize);
    expect(firstLayers).toBeGreaterThan(0);

    const refit = cpuMoeContextRefit({ ...BASE, firstPassLayers: firstLayers, contextSize: first.contextSize });
    expect(refit).not.toBeNull();
    const second = await resolveEffectiveContextSize(
      CARD_8GB.id,
      { ...MODEL, fileSizeGb: MODEL.fileSizeGb - refit!.offDeviceGb },
      { ...fitOpts, autoContextAtMost: refit!.atMost },
    );
    expect(second.contextSize).toBe(CPU_MOE_AUTO_CONTEXT);
    const finalLayers = decide(second.contextSize);
    expect(finalLayers).toBeGreaterThanOrEqual(firstLayers);
    expect(finalLayers).toBeLessThanOrEqual(SHAPE.blockCount);
  });
});
