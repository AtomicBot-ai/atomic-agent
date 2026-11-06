import { describe, expect, it } from "vitest";

import {
  buildKvLayout,
  COMPUTE_BASE_MIB,
  COMPUTE_OVERHEAD_MIB,
  DEFAULT_UBATCH_SIZE,
  estimateComputeReserveMiB,
  estimateContextSize,
  fitContextForSlots,
  MIN_AUTO_CONTEXT,
  UNKNOWN_VOCAB_SIZE,
  VISION_ENCODER_RESERVE_MIB,
  VISION_UBATCH_SIZE,
  type EstimateContextSizeInput,
} from "./context-size.js";
import { GPU_AUTO_MAX_SLOTS } from "./context-growth.js";
import { MAX_AUTO_SLOTS, resolveWorkerSlots } from "./worker-slots.js";

const MIB = 1024 * 1024;

/** Qwen 3.5+'s vocabulary (`tokenizer.ggml.tokens`). */
const QWEN_VOCAB = 248_320;

/**
 * A 27B hybrid shaped like qwen-3.8-27b: 64 blocks, every fourth one
 * attends (4 KV heads × 256 dims), the other 48 keep a gated delta-net
 * state. The dimensions are assumed, not read from the real file; the
 * 24 GB measurement (ATO-865) is where the real header comes from.
 */
const HYBRID_27B_LAYOUT = buildKvLayout({
  blockCount: 64,
  headCountKv: 4,
  keyLength: 256,
  valueLength: 256,
  fullAttentionInterval: 4,
});
/** 48 layers × (3 × (6144 + 2 × 16 × 128) + 128 × 6144) f32 values. */
const HYBRID_27B_STATE_BYTES = 48 * (3 * (6144 + 2 * 16 * 128) + 128 * 6144) * 4;
/** qwen-3.8-27b in the catalogue, with its projector. */
const QWEN38_27B = { modelSizeGb: 17.9, mmprojSizeGb: 0.99, maxContextLength: 262_144 };

/** Gemma 4 31B (see context-size.test.ts) and Qwen 3.5 4B layouts. */
const GEMMA4_31B_PATTERN = Array.from({ length: 60 }, (_, i) => (i + 1) % 6 !== 0);
const GEMMA4_31B_LAYOUT = buildKvLayout({
  blockCount: 60,
  headCountKv: GEMMA4_31B_PATTERN.map((slides) => (slides ? 16 : 4)),
  keyLength: 512,
  valueLength: 512,
  slidingWindow: 1024,
  slidingWindowPattern: GEMMA4_31B_PATTERN,
  keyLengthSwa: 256,
  valueLengthSwa: 256,
});
const GEMMA_31B = { modelSizeGb: 17.29, mmprojSizeGb: 1.2, maxContextLength: 262_144 };
const QWEN35_4B_LAYOUT = buildKvLayout({
  blockCount: 32,
  headCountKv: 4,
  keyLength: 256,
  valueLength: 256,
  fullAttentionInterval: 4,
});
const QWEN35_4B = { modelSizeGb: 2.7, mmprojSizeGb: 0, maxContextLength: 262_144 };

describe("estimateComputeReserveMiB (ATO-333)", () => {
  it("is exactly the old flat 768 MiB for an unknown model at the default micro-batch", () => {
    expect(COMPUTE_BASE_MIB + (DEFAULT_UBATCH_SIZE * UNKNOWN_VOCAB_SIZE * 4) / MIB).toBe(COMPUTE_OVERHEAD_MIB);
    expect(
      estimateComputeReserveMiB({ ubatchSize: DEFAULT_UBATCH_SIZE, vocabSize: null, hasVision: false, slots: 1 }),
    ).toBe(768);
  });

  it("never goes below the old flat figure, so a text-only small model keeps its window", () => {
    // 512 × 248,320 × 4 bytes is 485 MiB of logits: 741 with the base.
    expect(
      estimateComputeReserveMiB({ ubatchSize: DEFAULT_UBATCH_SIZE, vocabSize: QWEN_VOCAB, hasVision: false, slots: 8 }),
    ).toBe(768);
  });

  it("grows with the vision micro-batch, the vocabulary and the vision encoder", () => {
    expect(
      estimateComputeReserveMiB({ ubatchSize: VISION_UBATCH_SIZE, vocabSize: 262_144, hasVision: true, slots: 1 }),
    ).toBe(COMPUTE_BASE_MIB + 1024 + VISION_ENCODER_RESERVE_MIB);
    expect(
      estimateComputeReserveMiB({ ubatchSize: VISION_UBATCH_SIZE, vocabSize: QWEN_VOCAB, hasVision: true, slots: 1 }),
    ).toBe(256 + 970 + 512);
    // An unknown vocabulary is costed as the largest.
    expect(
      estimateComputeReserveMiB({ ubatchSize: VISION_UBATCH_SIZE, vocabSize: undefined, hasVision: true, slots: 1 }),
    ).toBe(1_792);
  });

  it("adds a hybrid's recurrent state once per slot", () => {
    const one = estimateComputeReserveMiB({
      ubatchSize: VISION_UBATCH_SIZE,
      vocabSize: QWEN_VOCAB,
      hasVision: true,
      slots: 1,
      recurrentStateBytesPerSlot: 100 * MIB,
    });
    const four = estimateComputeReserveMiB({
      ubatchSize: VISION_UBATCH_SIZE,
      vocabSize: QWEN_VOCAB,
      hasVision: true,
      slots: 4,
      recurrentStateBytesPerSlot: 100 * MIB,
    });
    expect(one).toBe(1_738 + 100);
    expect(four - one).toBe(300);
    // A model with no recurrent layers pays nothing per slot.
    expect(
      estimateComputeReserveMiB({ ubatchSize: DEFAULT_UBATCH_SIZE, vocabSize: null, hasVision: false, slots: 8 }),
    ).toBe(768);
  });
});

describe("fitContextForSlots (ATO-333)", () => {
  const slotsFor = (ctx: number) => Math.max(1, Math.min(8, Math.floor(ctx / 32_768)));
  const reserveFor = (slots: number) => 768 + 1_000 * slots;
  const fit = (reserveMiB: number) => 262_144 - reserveMiB * 64;

  it("takes the fewest slots whose reserve leaves a window that derives no more", () => {
    // One slot: 148,992 tokens, which would derive four. Two: 84,992, two.
    expect(fitContextForSlots({ maxSlots: 8, reserveFor, fit, slotsFor })).toEqual({
      contextSize: 84_992,
      slots: 2,
      computeReserveMiB: 2_768,
    });
  });

  it("stops at one slot when the window derives one", () => {
    expect(fitContextForSlots({ maxSlots: 8, reserveFor, fit, slotsFor: () => 1 })).toEqual({
      contextSize: fit(1_768),
      slots: 1,
      computeReserveMiB: 1_768,
    });
  });

  it("ends at the slot ceiling at the latest", () => {
    const result = fitContextForSlots({ maxSlots: 3, reserveFor, fit: () => 262_144, slotsFor });
    expect(result.slots).toBe(3);
    expect(result.computeReserveMiB).toBe(reserveFor(3));
  });

  it("launches no more slots than it reserved for, on a real slot rule", () => {
    const result = fitContextForSlots({
      maxSlots: MAX_AUTO_SLOTS,
      reserveFor: (slots) =>
        estimateComputeReserveMiB({
          ubatchSize: VISION_UBATCH_SIZE,
          vocabSize: QWEN_VOCAB,
          hasVision: true,
          slots,
          recurrentStateBytesPerSlot: HYBRID_27B_STATE_BYTES,
        }),
      fit: (computeReserveMiB) =>
        estimateContextSize({
          ...QWEN38_27B,
          freeVramMiB: 23_800,
          configuredContextSize: 0,
          kvLayout: HYBRID_27B_LAYOUT,
          computeReserveMiB,
        }),
      slotsFor: (contextSize) => resolveWorkerSlots({ contextSize, cpuOnly: false, maxSlots: GPU_AUTO_MAX_SLOTS }),
    });
    expect(
      resolveWorkerSlots({ contextSize: result.contextSize, cpuOnly: false, maxSlots: GPU_AUTO_MAX_SLOTS }),
    ).toBeLessThanOrEqual(result.slots);
  });
});

/** The fit with the flat reserve (as before) and with the launch's own. */
function before(input: Omit<EstimateContextSizeInput, "computeReserveMiB">): number {
  return estimateContextSize(input);
}
function after(
  input: Omit<EstimateContextSizeInput, "computeReserveMiB">,
  reserve: { vocabSize: number | null; slots: number; recurrentStateBytesPerSlot?: number },
): number {
  const hasVision = input.mmprojSizeGb > 0;
  return estimateContextSize({
    ...input,
    computeReserveMiB: estimateComputeReserveMiB({
      ubatchSize: hasVision ? VISION_UBATCH_SIZE : DEFAULT_UBATCH_SIZE,
      vocabSize: reserve.vocabSize,
      hasVision,
      slots: reserve.slots,
      ...(reserve.recurrentStateBytesPerSlot === undefined
        ? {}
        : { recurrentStateBytesPerSlot: reserve.recurrentStateBytesPerSlot }),
    }),
  });
}

describe("the window with the compute reserve, by machine (ATO-333)", () => {
  it("16 GB Mac: Qwen 3.5 4B keeps its 149,504 tokens", () => {
    const input = { ...QWEN35_4B, freeVramMiB: 10_922, configuredContextSize: 0, kvLayout: QWEN35_4B_LAYOUT, systemMemoryMiB: 16_384 };
    expect(before(input)).toBe(149_504);
    expect(after(input, { vocabSize: QWEN_VOCAB, slots: 4 })).toBe(149_504);
  });

  it("32 GB Mac: a 27B hybrid with its projector and four slots gets a smaller window than the flat reserve gave", () => {
    // Metal's figure on 32 GB is about two thirds of RAM.
    const input = { ...QWEN38_27B, freeVramMiB: 21_845, configuredContextSize: 0, kvLayout: HYBRID_27B_LAYOUT, systemMemoryMiB: 32_768 };
    const flat = before(input);
    const reserved = after(input, { vocabSize: QWEN_VOCAB, slots: 4, recurrentStateBytesPerSlot: HYBRID_27B_STATE_BYTES });
    expect(flat).toBeGreaterThan(MIN_AUTO_CONTEXT);
    expect(reserved).toBeLessThan(flat);
    // Weights, projector and buffers leave no room past the floor there.
    expect(reserved).toBe(MIN_AUTO_CONTEXT);
  });

  it("64 GB Mac: Gemma 4 31B and Qwen 3.5 4B lose no more than 10 %", () => {
    const gemma = { ...GEMMA_31B, freeVramMiB: 49_152, configuredContextSize: 0, kvLayout: GEMMA4_31B_LAYOUT, systemMemoryMiB: 65_536 };
    const qwen = { ...QWEN35_4B, freeVramMiB: 49_152, configuredContextSize: 0, kvLayout: QWEN35_4B_LAYOUT, systemMemoryMiB: 65_536 };
    const gemmaFlat = before(gemma);
    const qwenFlat = before(qwen);
    expect(after(gemma, { vocabSize: 262_144, slots: 8 })).toBeGreaterThanOrEqual(gemmaFlat * 0.9);
    expect(after(qwen, { vocabSize: QWEN_VOCAB, slots: 8 })).toBeGreaterThanOrEqual(qwenFlat * 0.9);
    // The 1/16 share binds on 64 GB, so in fact nothing moves.
    expect(after(gemma, { vocabSize: 262_144, slots: 8 })).toBe(gemmaFlat);
    expect(after(qwen, { vocabSize: QWEN_VOCAB, slots: 8 })).toBe(qwenFlat);
  });

  it("128 GB Mac: Gemma 4 31B keeps its trained 262,144", () => {
    const input = { ...GEMMA_31B, freeVramMiB: 98_304, configuredContextSize: 0, kvLayout: GEMMA4_31B_LAYOUT, systemMemoryMiB: 131_072 };
    expect(before(input)).toBe(262_144);
    expect(after(input, { vocabSize: 262_144, slots: 8 })).toBe(262_144);
  });

  it("a pinned context stays as set, whatever the reserve", () => {
    const input = { ...QWEN38_27B, freeVramMiB: 21_845, configuredContextSize: 65_536, kvLayout: HYBRID_27B_LAYOUT, systemMemoryMiB: 32_768 };
    expect(after(input, { vocabSize: QWEN_VOCAB, slots: 2, recurrentStateBytesPerSlot: HYBRID_27B_STATE_BYTES })).toBe(65_536);
  });
});

describe("the window with the compute reserve on a 24 GB card (ATO-866)", () => {
  /** Free VRAM a 24 GB card reports with nothing else loaded. */
  const CARD_24GB_FREE_MIB = 23_800;

  it("a 27B hybrid with its projector gets less than the flat reserve handed it", () => {
    const input = { ...QWEN38_27B, freeVramMiB: CARD_24GB_FREE_MIB, configuredContextSize: 0, kvLayout: HYBRID_27B_LAYOUT };
    const flat = before(input);
    const reserved = after(input, { vocabSize: QWEN_VOCAB, slots: GPU_AUTO_MAX_SLOTS, recurrentStateBytesPerSlot: HYBRID_27B_STATE_BYTES });
    expect(reserved).toBeLessThan(flat);
    expect(reserved).toBeGreaterThanOrEqual(MIN_AUTO_CONTEXT);
  });

  it("qwen-3.6-35b-a3b still lands on 32,768 (its weights fill the card)", () => {
    const input = { modelSizeGb: 22.4, mmprojSizeGb: 0, maxContextLength: 262_144, freeVramMiB: CARD_24GB_FREE_MIB, configuredContextSize: 0, kvLayout: HYBRID_27B_LAYOUT };
    expect(before(input)).toBe(MIN_AUTO_CONTEXT);
    expect(after(input, { vocabSize: QWEN_VOCAB, slots: 1 })).toBe(MIN_AUTO_CONTEXT);
  });
});
