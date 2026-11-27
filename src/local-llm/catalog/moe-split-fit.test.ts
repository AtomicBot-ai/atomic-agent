import { describe, expect, it } from "vitest";

import { hasDedicatedGpuMemory, moeSplitFor, type MoeSplitInput } from "./moe-split-fit.js";

/** Qwen 3.6 35B-A3B (22.4 GB) on 32 GB of RAM and an 8 GB RTX 4060. */
const BASE: MoeSplitInput = {
  weightsGb: 22.4,
  activeShare: 3 / 35,
  ramGb: 32,
  gpuWeightsGb: 8 * 0.85,
  cpuOnly: false,
  bandwidth: { gpuGbPerSec: 272, ramGbPerSec: 50, unified: false },
};

describe("hasDedicatedGpuMemory", () => {
  it("is true only for a GPU faster than the RAM, not unified", () => {
    expect(hasDedicatedGpuMemory(BASE.bandwidth)).toBe(true);
    expect(hasDedicatedGpuMemory({ gpuGbPerSec: 200, ramGbPerSec: 200, unified: true })).toBe(false);
    // An integrated GPU reads the same RAM: the estimate gives both the RAM figure.
    expect(hasDedicatedGpuMemory({ gpuGbPerSec: 50, ramGbPerSec: 50, unified: false })).toBe(false);
    // An Intel Mac, or no GPU.
    expect(hasDedicatedGpuMemory({ gpuGbPerSec: null, ramGbPerSec: 50, unified: false })).toBe(false);
    expect(hasDedicatedGpuMemory(undefined)).toBe(false);
  });
});

describe("moeSplitFor", () => {
  it("puts the experts that overflow an 8 GB card in 32 GB of RAM", () => {
    const split = moeSplitFor(BASE);
    expect(split).not.toBeNull();
    expect(split!.ramPartGb).toBeCloseTo(22.4 - 6.8, 5);
    expect(split!.comfortable).toBe(true);
  });

  it("is only tight when the RAM holds the experts' part with little room", () => {
    // 15.6 GB in RAM: ×1.5 + 2 = 26 > 24, ×1.2 = 19 <= 24.
    expect(moeSplitFor({ ...BASE, ramGb: 24 })).toEqual({ ramPartGb: expect.any(Number), comfortable: false });
  });

  it("gives nothing when the RAM cannot hold the experts' part", () => {
    expect(moeSplitFor({ ...BASE, ramGb: 16 })).toBeNull();
  });

  it("gives nothing for a dense model, a model that fits, or cpuMoe off", () => {
    expect(moeSplitFor({ ...BASE, activeShare: 1 })).toBeNull();
    expect(moeSplitFor({ ...BASE, weightsGb: 6 })).toBeNull();
    expect(moeSplitFor({ ...BASE, cpuMoe: "off" })).toBeNull();
  });

  it("keeps a pinned count and auto alike", () => {
    expect(moeSplitFor({ ...BASE, cpuMoe: 24 })?.comfortable).toBe(true);
    expect(moeSplitFor({ ...BASE, cpuMoe: "auto" })?.comfortable).toBe(true);
  });

  it("gives nothing without a dedicated GPU", () => {
    expect(moeSplitFor({ ...BASE, cpuOnly: true })).toBeNull();
    expect(moeSplitFor({ ...BASE, gpuWeightsGb: null })).toBeNull();
    expect(moeSplitFor({ ...BASE, bandwidth: { gpuGbPerSec: 200, ramGbPerSec: 200, unified: true } })).toBeNull();
    const { bandwidth: _unprobed, ...noBandwidth } = BASE;
    expect(moeSplitFor(noBandwidth)).toBeNull();
  });

  it("gives nothing when the GPU cannot hold the part every token reads", () => {
    // 80B-A3B (46 GB) reads ~1.7 GB a token; a 2 GB card's 1.7 GB share is short.
    expect(moeSplitFor({ ...BASE, weightsGb: 46, activeShare: 3 / 80, gpuWeightsGb: 1.6, ramGb: 128 })).toBeNull();
  });
});
