import { describe, expect, it } from "vitest";

import {
  kvLayoutSourceFromMetadata,
  parseGgufHeader,
  recurrentStateBytesPerSequence,
} from "../catalog/gguf-metadata.js";
import {
  encodeSyntheticGguf,
  gemma4_12bPairs,
  qwen36_35bA3bPairs,
  qwen38_27bPairs,
  type SyntheticGgufValue,
} from "../catalog/gguf-metadata.fixtures.js";
import {
  buildKvLayout,
  countKvLayers,
  DEFAULT_UBATCH_SIZE,
  estimateComputeReserveMiB,
  estimateContextSize,
  estimateLaunchKvBytes,
  fitContextForSlots,
  MIN_AUTO_CONTEXT,
  VISION_UBATCH_SIZE,
} from "./context-size.js";
import {
  GPU_AUTO_MAX_CONTEXT,
  GPU_AUTO_MAX_SLOTS,
  GPU_AUTO_START_CONTEXT,
  GPU_GROWING_MAX_SLOTS,
  resolveDedicatedGpuAutoContext,
} from "./context-growth.js";
import { MAX_AUTO_SLOTS, resolveWorkerSlots } from "./worker-slots.js";

/**
 * The auto window on a 24 GB card with its own memory, from the models'
 * real attention layouts (ATO-848, ATO-866). The layouts come from each
 * model's published config (`gguf-metadata.fixtures.ts`); the free VRAM
 * is what a 24 GB card reports with nothing else loaded. What a live
 * RTX 4090 actually allocates (ATO-865) is still to be measured.
 */

const MIB = 1024 * 1024;
const MIB_PER_GB = 1_000_000_000 / MIB;
const CARD_24GB_FREE_MIB = 23_800;
const VRAM_SAFETY_FRACTION = 0.92;
const QWEN_VOCAB = 248_320;

/** The catalogue entries (`models-catalog.ts`), with their projectors. */
const QWEN38_27B = { fileSizeGb: 17.9, mmprojFileSizeGb: 0.93, maxContextLength: 262_144 };
const GEMMA4_12B = { fileSizeGb: 6.72, mmprojFileSizeGb: 0.175, maxContextLength: 262_144 };
const QWEN36_35B_A3B = { fileSizeGb: 22.4, mmprojFileSizeGb: 0.9, maxContextLength: 262_144 };

function header(pairs: Record<string, SyntheticGgufValue>) {
  const meta = parseGgufHeader(encodeSyntheticGguf(pairs));
  const source = kvLayoutSourceFromMetadata(meta);
  if (!source) throw new Error("fixture header has no layout");
  return { layout: buildKvLayout(source), recurrent: recurrentStateBytesPerSequence(meta) };
}

/**
 * The auto launch on the card the way `resolveEffectiveContextSize` and
 * `buildLlamaServerArgs` size it for `parallel: "auto"` with the
 * projector loaded: slots and reserve fitted together under the
 * dedicated-GPU slot cap, the window then held by
 * `resolveDedicatedGpuAutoContext`, and `--parallel` derived from the
 * window the server gets.
 */
function autoLaunch(
  model: typeof QWEN38_27B,
  pairs: Record<string, SyntheticGgufValue>,
  vocabSize: number | null,
  growable = false,
) {
  const { layout, recurrent } = header(pairs);
  const slotCap = growable ? GPU_GROWING_MAX_SLOTS : GPU_AUTO_MAX_SLOTS;
  const reserveFor = (slots: number) =>
    estimateComputeReserveMiB({
      ubatchSize: VISION_UBATCH_SIZE,
      vocabSize,
      hasVision: true,
      slots,
      recurrentStateBytesPerSlot: recurrent,
    });
  const sized = fitContextForSlots({
    maxSlots: slotCap,
    reserveFor,
    fit: (computeReserveMiB) =>
      estimateContextSize({
        freeVramMiB: CARD_24GB_FREE_MIB,
        modelSizeGb: model.fileSizeGb,
        mmprojSizeGb: model.mmprojFileSizeGb,
        maxContextLength: model.maxContextLength,
        configuredContextSize: 0,
        kvLayout: layout,
        computeReserveMiB,
      }),
    slotsFor: (contextSize) =>
      resolveWorkerSlots({ contextSize, cpuOnly: false, maxSlots: slotCap }),
  });
  const gpu = resolveDedicatedGpuAutoContext({ fitContext: sized.contextSize, growable });
  const slots = resolveWorkerSlots({
    contextSize: gpu.contextSize,
    cpuOnly: false,
    maxSlots: gpu.maxSlots,
  });
  // Everything the launch puts on the card, against what the fit may use.
  const usedMiB =
    (model.fileSizeGb + model.mmprojFileSizeGb) * MIB_PER_GB +
    reserveFor(slots) +
    estimateLaunchKvBytes({
      kvLayout: layout,
      modelSizeGb: model.fileSizeGb,
      contextSize: gpu.contextSize,
    }) /
      MIB;
  return { contextSize: gpu.contextSize, slots, usedMiB, layout, recurrent };
}

const USABLE_MIB = CARD_24GB_FREE_MIB * VRAM_SAFETY_FRACTION;

describe("the headers of the 24 GB case (ATO-866)", () => {
  it("qwen-3.8-27b: 16 attention layers of 64, ~150 MiB of delta-net state per slot", () => {
    const { layout, recurrent } = header(qwen38_27bPairs());
    expect(countKvLayers(layout)).toEqual({ total: 64, global: 16, swa: 0, recurrent: 48 });
    expect(recurrent).toBe(48 * (3 * (6144 + 2 * 16 * 128) + 128 * 6144) * 4);
    expect(Math.round(recurrent / MIB)).toBe(150);
  });

  it("gemma-4-12b: 8 global layers with one KV head, 40 sliding ones", () => {
    const { layout, recurrent } = header(gemma4_12bPairs());
    expect(countKvLayers(layout)).toEqual({ total: 48, global: 8, swa: 40, recurrent: 0 });
    expect(layout.layers[5]).toEqual({ kind: "global", headCountKv: 1, keyLength: 512, valueLength: 512 });
    expect(layout.layers[0]).toEqual({ kind: "swa", headCountKv: 8, keyLength: 256, valueLength: 256 });
    expect(recurrent).toBe(0);
  });
});

describe("the auto launch on a 24 GB card (ATO-866)", () => {
  it("qwen-3.8-27b is no longer handed 262,144 × 8, and what it gets fits the card", () => {
    const launch = autoLaunch(QWEN38_27B, qwen38_27bPairs(), QWEN_VOCAB);
    expect(launch.contextSize === 262_144 && launch.slots === MAX_AUTO_SLOTS).toBe(false);
    expect(launch.contextSize).toBeLessThanOrEqual(GPU_AUTO_MAX_CONTEXT);
    expect(launch.slots).toBeLessThanOrEqual(GPU_AUTO_MAX_SLOTS);
    expect(launch.usedMiB).toBeLessThanOrEqual(USABLE_MIB);
    // 1,750 MiB of turbo3 cache, 2,187 MiB of buffers and state for 3 slots.
    expect(launch).toMatchObject({ contextSize: 128_000, slots: 3 });
  });

  it("gemma-4-12b gets the dedicated-GPU cap, 131,072 × 4, well inside the card", () => {
    const launch = autoLaunch(GEMMA4_12B, gemma4_12bPairs(), null);
    expect(launch).toMatchObject({ contextSize: GPU_AUTO_MAX_CONTEXT, slots: GPU_AUTO_MAX_SLOTS });
    // Its cache is ~0.5 GB at that window: memory does not explain its
    // slowness on the card (ATO-848), the live check (ATO-865) has to.
    expect(launch.usedMiB).toBeLessThan(USABLE_MIB - 10_000);
  });

  it("qwen-3.6-35b-a3b still gets 32,768 × 1", () => {
    const launch = autoLaunch(QWEN36_35B_A3B, qwen36_35bA3bPairs(), QWEN_VOCAB);
    expect(launch).toMatchObject({ contextSize: MIN_AUTO_CONTEXT, slots: 1 });
  });

  it("a launch that grows with the conversation starts both 27B and 12B at 32,768", () => {
    for (const [model, pairs, vocab] of [
      [QWEN38_27B, qwen38_27bPairs(), QWEN_VOCAB],
      [GEMMA4_12B, gemma4_12bPairs(), null],
    ] as const) {
      const launch = autoLaunch(model, pairs, vocab, true);
      expect(launch.contextSize).toBe(GPU_AUTO_START_CONTEXT);
      expect(launch.slots).toBeLessThanOrEqual(GPU_GROWING_MAX_SLOTS);
    }
  });

  it("the old fit (flat 768 MiB, no window or slot cap) would not have fit qwen-3.8-27b", () => {
    const { layout, recurrent } = header(qwen38_27bPairs());
    const oldContext = estimateContextSize({
      freeVramMiB: CARD_24GB_FREE_MIB,
      modelSizeGb: QWEN38_27B.fileSizeGb,
      mmprojSizeGb: QWEN38_27B.mmprojFileSizeGb,
      maxContextLength: QWEN38_27B.maxContextLength,
      configuredContextSize: 0,
      kvLayout: layout,
    });
    const oldSlots = resolveWorkerSlots({ contextSize: oldContext, cpuOnly: false });
    // 231,424 tokens and 7 slots, where the card has room for neither.
    expect(oldSlots).toBeGreaterThan(GPU_AUTO_MAX_SLOTS);
    const usedMiB =
      (QWEN38_27B.fileSizeGb + QWEN38_27B.mmprojFileSizeGb) * MIB_PER_GB +
      estimateComputeReserveMiB({
        ubatchSize: VISION_UBATCH_SIZE,
        vocabSize: QWEN_VOCAB,
        hasVision: true,
        slots: oldSlots,
        recurrentStateBytesPerSlot: recurrent,
      }) +
      estimateLaunchKvBytes({ kvLayout: layout, modelSizeGb: QWEN38_27B.fileSizeGb, contextSize: oldContext }) / MIB;
    expect(usedMiB).toBeGreaterThan(USABLE_MIB);
  });

  it("text-only (no projector) keeps the default micro-batch and never more room than with it", () => {
    const { layout } = header(qwen38_27bPairs());
    const fit = (mmprojSizeGb: number, ubatchSize: number, hasVision: boolean) =>
      estimateContextSize({
        freeVramMiB: CARD_24GB_FREE_MIB,
        modelSizeGb: QWEN38_27B.fileSizeGb,
        mmprojSizeGb,
        maxContextLength: QWEN38_27B.maxContextLength,
        configuredContextSize: 0,
        kvLayout: layout,
        computeReserveMiB: estimateComputeReserveMiB({ ubatchSize, vocabSize: QWEN_VOCAB, hasVision, slots: 1 }),
      });
    expect(fit(0, DEFAULT_UBATCH_SIZE, false)).toBeGreaterThanOrEqual(fit(QWEN38_27B.mmprojFileSizeGb, VISION_UBATCH_SIZE, true));
  });
});
