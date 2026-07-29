import { describe, expect, it } from "vitest";

import {
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
