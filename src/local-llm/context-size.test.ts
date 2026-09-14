import { describe, expect, it } from "vitest";

import {
  KV_BYTES_PER_TOKEN_PER_GB,
  KV_CACHE_BITS_PER_VALUE,
  KV_MIN_BYTES_PER_TOKEN,
  MANAGED_KV_CACHE_TYPE,
  MAX_AUTO_CONTEXT,
  MIN_AUTO_CONTEXT,
  NO_VRAM_DEFAULT_CONTEXT,
  buildKvLayout,
  countKvLayers,
  estimateContextSize,
  estimateKvBytesPerToken,
  estimateKvBytesTotal,
  fitContextToKvBudget,
  kvBitsPerValue,
  resolveDeviceFreeVramMiB,
  resolveKvBudgetMiB,
  type KvCacheLayout,
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

describe("MAX_AUTO_CONTEXT", () => {
  it("is 262,144 — the model's trained ceiling still clamps below it", () => {
    expect(MAX_AUTO_CONTEXT).toBe(262_144);
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

/**
 * Gemma 4 31B's attention layout, read from the header of
 * `gemma-4-31B-it-qat-UD-Q4_K_XL.gguf` (`gemma4.*`): 60 blocks; KV heads
 * alternate 16 on sliding layers and 4 on global ones; global head dims
 * 512, sliding 256; window 1024; pattern five sliding then one global.
 */
const GEMMA4_31B_PATTERN = Array.from({ length: 60 }, (_, i) => (i + 1) % 6 !== 0);
const GEMMA4_31B_LAYOUT: KvCacheLayout = buildKvLayout({
  blockCount: 60,
  headCountKv: GEMMA4_31B_PATTERN.map((slides) => (slides ? 16 : 4)),
  keyLength: 512,
  valueLength: 512,
  slidingWindow: 1024,
  slidingWindowPattern: GEMMA4_31B_PATTERN,
  keyLengthSwa: 256,
  valueLengthSwa: 256,
});

/** A dense 32B-class model: every layer global, 8 KV heads × 128 dims. */
const DENSE_32B_LAYOUT = buildKvLayout({
  blockCount: 64,
  headCountKv: 8,
  keyLength: 128,
  valueLength: 128,
});

/**
 * Qwen 3.5 4B (`qwen35.*`): 32 blocks, `full_attention_interval 4` — every
 * fourth layer attends, the rest are recurrent; 4 KV heads × 256 dims.
 */
const QWEN35_4B_LAYOUT = buildKvLayout({
  blockCount: 32,
  headCountKv: 4,
  keyLength: 256,
  valueLength: 256,
  fullAttentionInterval: 4,
});

/** Bytes of KV this estimate expects to fit, mirroring the module's own math. */
function kvBudgetBytes(input: {
  freeVramMiB: number;
  modelSizeGb: number;
  mmprojSizeGb: number;
}): number {
  return resolveKvBudgetMiB(input) * 1024 * 1024;
}

describe("buildKvLayout", () => {
  it("classifies Gemma 4 31B's layers from the sliding-window pattern", () => {
    expect(countKvLayers(GEMMA4_31B_LAYOUT)).toEqual({
      total: 60,
      global: 10,
      swa: 50,
      recurrent: 0,
    });
    expect(GEMMA4_31B_LAYOUT.slidingWindow).toBe(1024);
    // Sliding layers take the `_swa` head dims, global ones the plain.
    expect(GEMMA4_31B_LAYOUT.layers[0]).toEqual({
      kind: "swa",
      headCountKv: 16,
      keyLength: 256,
      valueLength: 256,
    });
    expect(GEMMA4_31B_LAYOUT.layers[5]).toEqual({
      kind: "global",
      headCountKv: 4,
      keyLength: 512,
      valueLength: 512,
    });
  });

  it("reads a window without a pattern as every layer sliding", () => {
    const layout = buildKvLayout({
      blockCount: 4,
      headCountKv: 2,
      keyLength: 64,
      valueLength: 64,
      slidingWindow: 512,
    });
    expect(countKvLayers(layout).swa).toBe(4);
  });

  it("marks the recurrent layers of a hybrid from full_attention_interval", () => {
    expect(countKvLayers(QWEN35_4B_LAYOUT)).toEqual({
      total: 32,
      global: 8,
      swa: 0,
      recurrent: 24,
    });
    expect(QWEN35_4B_LAYOUT.layers[3]?.kind).toBe("global");
    expect(QWEN35_4B_LAYOUT.layers[0]?.kind).toBe("recurrent");
  });

  it("prefers an explicit recurrent pattern over the interval", () => {
    const layout = buildKvLayout({
      blockCount: 3,
      headCountKv: 1,
      keyLength: 8,
      valueLength: 8,
      fullAttentionInterval: 4,
      recurrentLayerPattern: [false, true, false],
    });
    expect(layout.layers.map((l) => l.kind)).toEqual([
      "global",
      "recurrent",
      "global",
    ]);
  });
});

describe("estimateKvBytesPerToken", () => {
  it("lands within 2× of the KV cost measured for Gemma 4 31B at 131,072 with turbo3", () => {
    // Measured (notes/kv-measurement.md): +1,342 MB of phys_footprint for
    // +98,304 tokens of unified cache under the managed launch flags
    // (`--cache-type-k turbo3 --cache-type-v turbo3 -kvu`) ≈ 13.7 KB per
    // token. Both readings of "MB" are checked.
    expect(MANAGED_KV_CACHE_TYPE).toBe("turbo3");
    const estimate = estimateKvBytesPerToken(
      GEMMA4_31B_LAYOUT,
      MANAGED_KV_CACHE_TYPE,
      131_072,
    );
    for (const measured of [
      (1_342 * 1024 * 1024) / 98_304,
      (1_342 * 1_000_000) / 98_304,
    ]) {
      expect(estimate).toBeGreaterThan(measured / 2);
      expect(estimate).toBeLessThan(measured * 2);
    }
    // The arithmetic the figure comes from: 10 global layers × 2 × 4 heads
    // × 512 dims × 3.5 bits, plus 50 sliding layers × 2 × 16 × 256 × 3.5
    // bits weighted by 1024 / 131,072.
    const global = (10 * 2 * 4 * 512 * 3.5) / 8;
    const swa = ((50 * 2 * 16 * 256 * 3.5) / 8) * (1024 / 131_072);
    expect(estimate).toBeCloseTo(global + swa, 6);
  });

  it("weights sliding layers by min(window, ctx) / ctx, so the figure falls with the context", () => {
    const at4k = estimateKvBytesPerToken(GEMMA4_31B_LAYOUT, "turbo3", 4_096);
    const at131k = estimateKvBytesPerToken(GEMMA4_31B_LAYOUT, "turbo3", 131_072);
    expect(at4k).toBeGreaterThan(at131k * 2);
    // Below the window every layer scales with the context.
    const at512 = estimateKvBytesPerToken(GEMMA4_31B_LAYOUT, "turbo3", 512);
    const everyLayerFull =
      (10 * 2 * 4 * 512 * 3.5) / 8 + (50 * 2 * 16 * 256 * 3.5) / 8;
    expect(at512).toBeCloseTo(everyLayerFull, 6);
  });

  it("costs a dense model the same per token at any context", () => {
    const expected = (64 * 2 * 8 * 128 * 3.5) / 8;
    expect(estimateKvBytesPerToken(DENSE_32B_LAYOUT, "turbo3", 4_096)).toBe(
      expected,
    );
    expect(estimateKvBytesPerToken(DENSE_32B_LAYOUT, "turbo3", 131_072)).toBe(
      expected,
    );
  });

  it("charges nothing per token for a hybrid's recurrent layers", () => {
    const expected = (8 * 2 * 4 * 256 * 3.5) / 8;
    expect(estimateKvBytesPerToken(QWEN35_4B_LAYOUT, "turbo3", 65_536)).toBe(
      expected,
    );
  });

  it("scales with the cache type: q8 ≈ 8.5 bits, f16 = 16, unknown costed as f16", () => {
    expect(KV_CACHE_BITS_PER_VALUE.turbo3).toBe(3.5);
    expect(KV_CACHE_BITS_PER_VALUE.q8_0).toBe(8.5);
    expect(KV_CACHE_BITS_PER_VALUE.f16).toBe(16);
    expect(kvBitsPerValue("something-new")).toBe(16);
    const turbo3 = estimateKvBytesPerToken(DENSE_32B_LAYOUT, "turbo3", 8_192);
    expect(estimateKvBytesPerToken(DENSE_32B_LAYOUT, "q8_0", 8_192)).toBeCloseTo(
      (turbo3 * 8.5) / 3.5,
      6,
    );
    expect(estimateKvBytesPerToken(DENSE_32B_LAYOUT, "f16", 8_192)).toBeCloseTo(
      (turbo3 * 16) / 3.5,
      6,
    );
  });

  it("with --swa-full every sliding layer costs like a global one", () => {
    const full = estimateKvBytesPerToken(
      GEMMA4_31B_LAYOUT,
      "turbo3",
      131_072,
      { swaFull: true },
    );
    const everyLayerFull =
      (10 * 2 * 4 * 512 * 3.5) / 8 + (50 * 2 * 16 * 256 * 3.5) / 8;
    expect(full).toBeCloseTo(everyLayerFull, 6);
    // Several-fold, as the fix plan warned: this is what the auto
    // decision has to weigh against the memory budget.
    expect(full / estimateKvBytesPerToken(GEMMA4_31B_LAYOUT, "turbo3", 131_072))
      .toBeGreaterThan(5);
  });

  it("is zero for a non-positive context", () => {
    expect(estimateKvBytesPerToken(DENSE_32B_LAYOUT, "turbo3", 0)).toBe(0);
  });
});

describe("fitContextToKvBudget", () => {
  it("returns the largest context whose total fits, past and below the window", () => {
    for (const budget of [1e6, 5e7, 4e9, 2e10]) {
      const fit = fitContextToKvBudget(GEMMA4_31B_LAYOUT, "turbo3", budget);
      expect(
        estimateKvBytesTotal(GEMMA4_31B_LAYOUT, "turbo3", fit),
      ).toBeLessThanOrEqual(budget);
      expect(
        estimateKvBytesTotal(GEMMA4_31B_LAYOUT, "turbo3", fit + 1),
      ).toBeGreaterThan(budget);
    }
  });

  it("is exact for a dense model", () => {
    const perToken = estimateKvBytesPerToken(DENSE_32B_LAYOUT, "turbo3", 1);
    expect(fitContextToKvBudget(DENSE_32B_LAYOUT, "turbo3", perToken * 10_000)).toBe(
      10_000,
    );
  });

  it("fits nothing into no budget and everything into a cache-free model", () => {
    expect(fitContextToKvBudget(DENSE_32B_LAYOUT, "turbo3", 0)).toBe(0);
    const recurrentOnly = buildKvLayout({
      blockCount: 2,
      headCountKv: 1,
      keyLength: 8,
      valueLength: 8,
      recurrentLayerPattern: [true, true],
    });
    expect(fitContextToKvBudget(recurrentOnly, "turbo3", 1)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe("the fallback per-token estimate (no header)", () => {
  it("stays well above the KV cost measured under the managed launch flags", () => {
    const measured = (1_342 * 1024 * 1024) / 98_304;
    const estimated = GEMMA_31B.modelSizeGb * KV_BYTES_PER_TOKEN_PER_GB;
    expect(estimated).toBeGreaterThanOrEqual(3.5 * measured);
  });

  it("still covers a dense, full-attention model at 3.5 bits per value", () => {
    const bytesPerToken = (layers: number): number =>
      (2 * layers * 8 * 128 * 3.5) / 8;
    expect(19.8 * KV_BYTES_PER_TOKEN_PER_GB).toBeGreaterThanOrEqual(
      bytesPerToken(64),
    );
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
    expect(
      estimateContextSize({
        ...QWEN_9B,
        freeVramMiB: 7054,
        configuredContextSize: 0,
        kvLayout: DENSE_32B_LAYOUT,
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

  it("gives Gemma 4 31B its trained context on a 64 GB Mac from its own layout", () => {
    // Metal reports roughly three quarters of unified memory as the
    // working set; 48 GiB is a conservative reading for 64 GB. The
    // layout says 262,144 tokens of turbo3 cache cost ~5 GB here.
    const input = { ...GEMMA_31B, freeVramMiB: 49_152 };
    expect(
      estimateKvBytesTotal(GEMMA4_31B_LAYOUT, "turbo3", 262_144),
    ).toBeLessThan(kvBudgetBytes(input));
    expect(
      estimateContextSize({
        ...input,
        configuredContextSize: 0,
        kvLayout: GEMMA4_31B_LAYOUT,
      }),
    ).toBe(262_144);
  });

  it("fits Gemma 4 31B on a 32 GB M1 Max where the file-size scale held it to the floor", () => {
    // `MTL0: Apple M1 Max (25559 MiB, 25558 MiB free)` — see gpu-devices.ts.
    const input = { ...GEMMA_31B, freeVramMiB: 25_558 };
    const fallback = estimateContextSize({ ...input, configuredContextSize: 0 });
    const fromLayout = estimateContextSize({
      ...input,
      configuredContextSize: 0,
      kvLayout: GEMMA4_31B_LAYOUT,
    });
    expect(fromLayout).toBeGreaterThan(fallback);
    expect(fromLayout % 1024).toBe(0);
    expect(
      estimateKvBytesTotal(GEMMA4_31B_LAYOUT, "turbo3", fromLayout),
    ).toBeLessThanOrEqual(kvBudgetBytes(input));
  });

  it("holds a dense model to what its cache really costs", () => {
    // ~19.8 GB dense 32B on a 32 GB M1 Max: 57 KB per token against ~4 GB
    // of budget, so the fit lands well under the ceiling and the layout
    // says exactly how far.
    const input = { modelSizeGb: 19.8, mmprojSizeGb: 0, freeVramMiB: 25_558 };
    const ctx = estimateContextSize({
      ...input,
      maxContextLength: 262_144,
      configuredContextSize: 0,
      kvLayout: DENSE_32B_LAYOUT,
    });
    expect(ctx).toBeLessThan(MAX_AUTO_CONTEXT);
    expect(ctx).toBeGreaterThan(MIN_AUTO_CONTEXT);
    expect(
      estimateKvBytesTotal(DENSE_32B_LAYOUT, "turbo3", ctx),
    ).toBeLessThanOrEqual(kvBudgetBytes(input));
    expect(
      estimateKvBytesTotal(DENSE_32B_LAYOUT, "turbo3", ctx + 1024),
    ).toBeGreaterThan(kvBudgetBytes(input));
  });

  it("counts --swa-full into the fit", () => {
    const input = { ...GEMMA_31B, freeVramMiB: 25_558 };
    const swa = estimateContextSize({
      ...input,
      configuredContextSize: 0,
      kvLayout: GEMMA4_31B_LAYOUT,
    });
    const full = estimateContextSize({
      ...input,
      configuredContextSize: 0,
      kvLayout: GEMMA4_31B_LAYOUT,
      swaFull: true,
    });
    expect(full).toBeLessThan(swa);
  });

  it("costs a small model at the fallback's per-token floor, not by its file size", () => {
    const input = { modelSizeGb: 2.7, mmprojSizeGb: 0, freeVramMiB: 7_054 };
    const ctx = estimateContextSize({
      ...input,
      maxContextLength: 262_144,
      configuredContextSize: 0,
    });
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
        kvLayout: GEMMA4_31B_LAYOUT,
      }),
    ).toBe(65_536);
    expect(
      estimateContextSize({
        ...GEMMA_31B,
        maxContextLength: 131_072,
        freeVramMiB: 49_152,
        configuredContextSize: 0,
      }),
    ).toBe(131_072);
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
