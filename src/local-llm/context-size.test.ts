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
  resolveUnifiedMemoryKvCapMiB,
  UNIFIED_MEMORY_KV_SHARE,
  UNIFIED_MEMORY_RESERVE_SHARE,
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
describe("NO_VRAM_DEFAULT_CONTEXT", () => {
  it("never falls below the auto-size floor", () => {
    expect(NO_VRAM_DEFAULT_CONTEXT).toBeGreaterThanOrEqual(MIN_AUTO_CONTEXT);
  });
});

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

/**
 * Backlog 42: Qwen 3.5 4B started with `--ctx-size 262144` "fitted from
 * the model's KV layout" on a 16 GB Mac that was 13.5 GB into swap.
 * Metal reports its working-set ceiling as free whatever else runs, so
 * the fit alone had ~6.5 GB to spend; on unified memory the auto size is
 * also held to two shares of physical RAM.
 */
describe("the unified-memory cap (backlog 42)", () => {
  /** The catalogue's Qwen 3.5 4B, text-only (no projector on disk). */
  const QWEN35_4B = { modelSizeGb: 2.7, mmprojSizeGb: 0, maxContextLength: 262_144 };
  /** What Metal reports as free on a 16 GB Apple silicon Mac (its working-set ceiling). */
  const MAC_16GB_METAL_FREE_MIB = 10_922;

  it("costs Qwen 3.5 4B 7 KiB per token: 1.75 GiB at 262,144, 224 MiB at 32,768", () => {
    // 8 attention layers × 4 KV heads × (256 + 256) dims × 3.5 bits.
    expect(estimateKvBytesPerToken(QWEN35_4B_LAYOUT, MANAGED_KV_CACHE_TYPE, 262_144)).toBe(7_168);
    expect(estimateKvBytesTotal(QWEN35_4B_LAYOUT, MANAGED_KV_CACHE_TYPE, 262_144)).toBe(1.75 * 1024 ** 3);
    expect(estimateKvBytesTotal(QWEN35_4B_LAYOUT, MANAGED_KV_CACHE_TYPE, 32_768)).toBe(224 * 1024 ** 2);
  });

  it("gave Qwen 3.5 4B its whole trained context on a 16 GB Mac from Metal's figure alone", () => {
    expect(
      estimateContextSize({
        ...QWEN35_4B,
        freeVramMiB: MAC_16GB_METAL_FREE_MIB,
        configuredContextSize: 0,
        kvLayout: QWEN35_4B_LAYOUT,
      }),
    ).toBe(262_144);
  });

  it("holds it to 1 GiB of cache on that Mac: 149,504 tokens", () => {
    const ctx = estimateContextSize({
      ...QWEN35_4B,
      freeVramMiB: MAC_16GB_METAL_FREE_MIB,
      configuredContextSize: 0,
      kvLayout: QWEN35_4B_LAYOUT,
      systemMemoryMiB: 16_384,
    });
    expect(ctx).toBe(149_504);
    expect(estimateKvBytesTotal(QWEN35_4B_LAYOUT, MANAGED_KV_CACHE_TYPE, ctx)).toBeLessThanOrEqual(
      16_384 * UNIFIED_MEMORY_KV_SHARE * 1024 * 1024,
    );
  });

  it("scales with the machine: 74,752 on 8 GB, the trained 262,144 on 32 GB (1.75 GiB fits its 2 GiB)", () => {
    const at = (systemMemoryMiB: number, freeVramMiB: number) =>
      estimateContextSize({
        ...QWEN35_4B,
        freeVramMiB,
        configuredContextSize: 0,
        kvLayout: QWEN35_4B_LAYOUT,
        systemMemoryMiB,
      });
    expect(at(8_192, 5_461)).toBe(74_752);
    expect(at(32_768, 21_845)).toBe(262_144);
  });

  it("keeps Gemma 4 31B above 200k on a 64 GB Mac (4 GiB of cache)", () => {
    const ctx = estimateContextSize({
      ...GEMMA_31B,
      freeVramMiB: 49_152,
      configuredContextSize: 0,
      kvLayout: GEMMA4_31B_LAYOUT,
      systemMemoryMiB: 65_536,
    });
    expect(ctx).toBe(229_376);
    expect(estimateKvBytesTotal(GEMMA4_31B_LAYOUT, MANAGED_KV_CACHE_TYPE, ctx)).toBeLessThanOrEqual(
      4 * 1024 ** 3,
    );
  });

  it("lands on the floor when the weights alone take the half the system keeps", () => {
    // Gemma 4 31B with its projector (18.5 GB) on a 32 GB Mac.
    expect(
      resolveUnifiedMemoryKvCapMiB({
        systemMemoryMiB: 32_768,
        modelSizeGb: GEMMA_31B.modelSizeGb,
        mmprojSizeGb: GEMMA_31B.mmprojSizeGb,
      }),
    ).toBeLessThan(0);
    expect(
      estimateContextSize({
        ...GEMMA_31B,
        freeVramMiB: 25_558,
        configuredContextSize: 0,
        kvLayout: GEMMA4_31B_LAYOUT,
        systemMemoryMiB: 32_768,
      }),
    ).toBe(MIN_AUTO_CONTEXT);
  });

  it("is the smaller of the server's share and the cache's share", () => {
    const input = { systemMemoryMiB: 16_384, modelSizeGb: 2.7, mmprojSizeGb: 0 };
    expect(UNIFIED_MEMORY_RESERVE_SHARE).toBe(0.5);
    expect(resolveUnifiedMemoryKvCapMiB(input)).toBe(1_024);
    expect(
      resolveKvBudgetMiB({ ...input, freeVramMiB: MAC_16GB_METAL_FREE_MIB }),
    ).toBe(1_024);
    // A tight free figure still wins over the shares.
    expect(resolveKvBudgetMiB({ ...input, freeVramMiB: 4_000 })).toBe(
      resolveKvBudgetMiB({ freeVramMiB: 4_000, modelSizeGb: 2.7, mmprojSizeGb: 0 }),
    );
  });

  it("leaves a GPU with memory of its own, and a pinned context, as they were", () => {
    // No system memory given: a discrete card's free VRAM is its own.
    expect(
      estimateContextSize({
        ...QWEN35_4B,
        freeVramMiB: MAC_16GB_METAL_FREE_MIB,
        configuredContextSize: 0,
        kvLayout: QWEN35_4B_LAYOUT,
        systemMemoryMiB: null,
      }),
    ).toBe(262_144);
    // The operator's number stays as set, unified memory or not.
    expect(
      estimateContextSize({
        ...QWEN35_4B,
        freeVramMiB: MAC_16GB_METAL_FREE_MIB,
        configuredContextSize: 262_144,
        kvLayout: QWEN35_4B_LAYOUT,
        systemMemoryMiB: 16_384,
      }),
    ).toBe(262_144);
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
