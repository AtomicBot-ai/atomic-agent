import { describe, expect, it } from "vitest";

import {
  KV_BYTES_PER_TOKEN_PER_GB,
  KV_MIN_BYTES_PER_TOKEN,
  MAX_AUTO_CONTEXT,
  MIN_AUTO_CONTEXT,
  NO_VRAM_DEFAULT_CONTEXT,
  estimateContextSize,
  resolveDeviceFreeVramMiB,
} from "./context-size.js";
import type { GpuDevice } from "./gpu-devices.js";
import { minUsableContextWindow } from "../prompt/token-budget.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";

// Drift guard. The floor exists so a model that does not fit VRAM still
// gets a *workable* context rather than a merely non-zero one. When it sat
// at 8192 it was equal to `completionMaxTokens` and smaller than the fixed
// prompt plus that budget, so every step on a floored model came back
// `truncated` and the agent never emitted a tool call. Either constant may
// move; they must not cross.
describe("MIN_AUTO_CONTEXT", () => {
  it("clears the agent's fixed prompt plus a full generation budget", () => {
    const required = minUsableContextWindow(
      USER_CONFIG_DEFAULTS.localModels.completionMaxTokens,
    );
    expect(MIN_AUTO_CONTEXT).toBeGreaterThanOrEqual(required);
  });

  it("is not itself capped away by the auto-size ceiling", () => {
    expect(MIN_AUTO_CONTEXT).toBeLessThanOrEqual(MAX_AUTO_CONTEXT);
  });
});

const QWEN_9B = {
  modelSizeGb: 5.3,
  mmprojSizeGb: 0.92,
  maxContextLength: 262_144,
};

const GEMMA_31B = {
  modelSizeGb: 17.29,
  mmprojSizeGb: 1.2,
  maxContextLength: 262_144,
};

/** Bytes of KV this estimate expects to fit, mirroring the module's own math. */
function kvBudgetBytes(input: {
  freeVramMiB: number;
  modelSizeGb: number;
  mmprojSizeGb: number;
}): number {
  const mibPerGb = 1_000_000_000 / (1024 * 1024);
  const usable = input.freeVramMiB * 0.92;
  const weights = (input.modelSizeGb + input.mmprojSizeGb) * mibPerGb;
  return (usable - weights - 768) * 1024 * 1024;
}

describe("the per-token KV estimate", () => {
  it("stays well above the KV cost measured under the managed launch flags", () => {
    // Gemma 4 31B QAT (17.29 GB), turbo3 K and V, -kvu, 64 GB M1 Max:
    // phys_footprint 1,315 MB at ctx 32,768 and 2,657 MB at 131,072.
    // Read as MiB, the stricter of the two readings of "MB".
    const measured = (1_342 * 1024 * 1024) / 98_304;
    const estimated = GEMMA_31B.modelSizeGb * KV_BYTES_PER_TOKEN_PER_GB;
    expect(estimated).toBeGreaterThanOrEqual(3.5 * measured);
  });

  it("still covers a dense, full-attention model at 3.5 bits per value", () => {
    const bytesPerToken = (layers: number): number =>
      (2 * layers * 8 * 128 * 3.5) / 8;
    // 32B-class, ~19.8 GB at Q4: covered by the per-GB scale.
    expect(19.8 * KV_BYTES_PER_TOKEN_PER_GB).toBeGreaterThanOrEqual(
      bytesPerToken(64),
    );
    // 8B-class, ~5 GB at Q4: the scale alone would under-count it; the
    // per-token floor is what covers it.
    expect(5 * KV_BYTES_PER_TOKEN_PER_GB).toBeLessThan(bytesPerToken(36));
    expect(KV_MIN_BYTES_PER_TOKEN).toBeGreaterThan(bytesPerToken(36));
  });
});

describe("estimateContextSize", () => {
  it("honors a positive operator override, clamped to the model ceiling", () => {
    expect(
      estimateContextSize({
        ...QWEN_9B,
        freeVramMiB: 7000,
        configuredContextSize: 12288,
      }),
    ).toBe(12288);
    expect(
      estimateContextSize({
        ...QWEN_9B,
        maxContextLength: 8192,
        freeVramMiB: 40000,
        configuredContextSize: 65536,
      }),
    ).toBe(8192);
  });

  it("uses the no-VRAM default when no GPU budget is known", () => {
    expect(
      estimateContextSize({
        ...QWEN_9B,
        freeVramMiB: null,
        configuredContextSize: 0,
      }),
    ).toBe(NO_VRAM_DEFAULT_CONTEXT);
  });

  it("forces the floor when VRAM is too tight to fit more (small GPU)", () => {
    // 8 GB laptop GPU with a 9B + vision model: weights already eat most
    // of the card, so the fit estimate lands below the floor and we force
    // MIN_AUTO_CONTEXT (llama.cpp -fit spills layers to CPU).
    expect(
      estimateContextSize({
        ...QWEN_9B,
        freeVramMiB: 7054,
        configuredContextSize: 0,
      }),
    ).toBe(MIN_AUTO_CONTEXT);
  });

  it("scales the context up on a roomy GPU, capped at MAX_AUTO_CONTEXT", () => {
    const ctx = estimateContextSize({
      ...QWEN_9B,
      freeVramMiB: 48000,
      configuredContextSize: 0,
    });
    expect(ctx).toBe(MAX_AUTO_CONTEXT);
  });

  it("lets memory, not a 32k cap, decide on a big unified-memory machine", () => {
    // The machine the old ceiling held to one worker's context. Metal
    // reports roughly three quarters of unified memory as the working
    // set; 48 GiB is a conservative reading for 64 GB.
    expect(MAX_AUTO_CONTEXT).toBeGreaterThan(32_768);
    expect(
      estimateContextSize({
        ...GEMMA_31B,
        freeVramMiB: 49_152,
        configuredContextSize: 0,
      }),
    ).toBe(MAX_AUTO_CONTEXT);
  });

  it("fits between the floor and the ceiling on a 32 GB M1 Max", () => {
    // `MTL0: Apple M1 Max (25559 MiB, 25558 MiB free)` — see gpu-devices.ts.
    const input = { ...GEMMA_31B, freeVramMiB: 25_558 };
    const ctx = estimateContextSize({ ...input, configuredContextSize: 0 });
    expect(ctx).toBeGreaterThan(MIN_AUTO_CONTEXT);
    expect(ctx).toBeLessThan(MAX_AUTO_CONTEXT);
    expect(ctx % 1024).toBe(0);
    expect(ctx * GEMMA_31B.modelSizeGb * KV_BYTES_PER_TOKEN_PER_GB).toBeLessThanOrEqual(
      kvBudgetBytes(input),
    );
  });

  it("costs a small model at the per-token floor, not by its file size", () => {
    const input = { modelSizeGb: 2.7, mmprojSizeGb: 0, freeVramMiB: 7_054 };
    const ctx = estimateContextSize({
      ...input,
      maxContextLength: 262_144,
      configuredContextSize: 0,
    });
    // By file size alone this card would be handed the whole ceiling.
    expect(
      kvBudgetBytes(input) / (input.modelSizeGb * KV_BYTES_PER_TOKEN_PER_GB),
    ).toBeGreaterThan(MAX_AUTO_CONTEXT);
    expect(ctx).toBeLessThan(MAX_AUTO_CONTEXT);
    expect(ctx * KV_MIN_BYTES_PER_TOKEN).toBeLessThanOrEqual(kvBudgetBytes(input));
  });

  it("returns a multiple of 1024 within the auto range", () => {
    const ctx = estimateContextSize({
      modelSizeGb: 2.7,
      mmprojSizeGb: 0,
      maxContextLength: 262_144,
      freeVramMiB: 12000,
      configuredContextSize: 0,
    });
    expect(ctx % 1024).toBe(0);
    expect(ctx).toBeGreaterThanOrEqual(MIN_AUTO_CONTEXT);
    expect(ctx).toBeLessThanOrEqual(MAX_AUTO_CONTEXT);
  });

  it("never exceeds a small model ceiling even with lots of VRAM", () => {
    const ctx = estimateContextSize({
      modelSizeGb: 2.7,
      mmprojSizeGb: 0,
      maxContextLength: 4096,
      freeVramMiB: 48000,
      configuredContextSize: 0,
    });
    expect(ctx).toBe(4096);
  });

  it("never exceeds the model's trained ceiling below MAX_AUTO_CONTEXT", () => {
    expect(
      estimateContextSize({
        ...GEMMA_31B,
        maxContextLength: 65_536,
        freeVramMiB: 49_152,
        configuredContextSize: 0,
      }),
    ).toBe(65_536);
  });
});

describe("resolveDeviceFreeVramMiB", () => {
  const devices: GpuDevice[] = [
    {
      id: "CUDA0",
      description: "NVIDIA GeForce RTX 4070 Laptop GPU",
      totalMemMiB: 8187,
      freeMemMiB: 7054,
    },
    {
      id: "CUDA1",
      description: "NVIDIA H100",
      totalMemMiB: 81000,
      freeMemMiB: 0,
    },
  ];

  it("returns free VRAM for the matched device", () => {
    expect(resolveDeviceFreeVramMiB(devices, "CUDA0")).toBe(7054);
  });

  it("falls back to total when free is unreported", () => {
    expect(resolveDeviceFreeVramMiB(devices, "CUDA1")).toBe(81000);
  });

  it("returns null for cpu / undefined / unknown device", () => {
    expect(resolveDeviceFreeVramMiB(devices, "cpu")).toBeNull();
    expect(resolveDeviceFreeVramMiB(devices, undefined)).toBeNull();
    expect(resolveDeviceFreeVramMiB(devices, "Vulkan9")).toBeNull();
  });
});
