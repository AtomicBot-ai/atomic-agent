/**
 * ATO-450 — for each quantisation in a Hugging Face repo: does it fit
 * this machine, roughly how fast would it answer, and which one should
 * be offered first.
 *
 * - Fit uses the same two limits as the rest of the catalog: the GPU
 *   share of `model-upgrade.ts` (weights in 85% of the GPU memory) and
 *   the RAM envelope `buildCustomModelDef` writes for an added model
 *   (`minRamGb` = weights × 1.2, `recommendedRamGb` = weights × 1.5 + 2).
 * - Speed is a forecast, not a measurement: generating one token reads
 *   every active weight once, so tokens per second is about the memory
 *   bandwidth divided by the bytes read per token, times an efficiency
 *   factor, with the part that spilled out of the GPU read at RAM speed.
 *   Every label says "estimate".
 * - The pick is the highest-precision quant (never below 4-bit) that
 *   fits the GPU and still answers at a pleasant speed.
 *
 * Pure — the machine facts come from `../backend/machine-for-models.ts`.
 */

import type { MemoryBandwidth } from "../backend/memory-bandwidth.js";
import { GPU_WEIGHTS_SHARE, type MachineForModels } from "./model-upgrade.js";

export type QuantFitTier = "fits" | "tight" | "too-big";

export interface QuantFit {
  tier: QuantFitTier;
  /** The words the desktop badge already uses for catalog models. */
  label: "Fits well" | "Tight fit" | "Too big";
  /**
   * Where the weights would sit: all in the GPU, partly in system RAM
   * (or all of it, on a machine without a GPU), or nowhere that fits.
   */
  placement: "gpu" | "ram" | "disk";
}

export interface SpeedForecast {
  /**
   * Tokens per second to one decimal; a forecast, see the module
   * comment. Only the label rounds further, so a threshold compares the
   * forecast rather than its rounding.
   */
  tokPerSec: number;
  /** `~25 tok/s, estimate`, always with the word "estimate". */
  label: string;
}

/** Below this an answer feels slow; the pick prefers quants above it. */
export const PLEASANT_TOK_PER_SEC = 20;

/** The pick never offers fewer bits than this. */
export const MIN_AUTO_PICK_BITS = 4;

/**
 * Share of the peak bandwidth decode really reaches. Conservative on
 * purpose: a forecast that comes in fast is a broken promise, one that
 * comes in slow is a pleasant surprise.
 */
export const GPU_DECODE_EFFICIENCY = 0.55;
export const UNIFIED_DECODE_EFFICIENCY = 0.6;
export const CPU_DECODE_EFFICIENCY = 0.5;

/**
 * A mixture-of-experts model reads only its active experts per token,
 * but routing and the shared layers cost more than the active share
 * alone suggests.
 */
export const MOE_ROUTING_EFFICIENCY = 0.6;

const BYTES_PER_GB = 1_000_000_000;

/**
 * The nominal bit level of a GGUF from its name: `Q4_K_M` → 4,
 * `UD-IQ3_XXS` → 3, `Q8_0` → 8, `MXFP4` → 4. `null` when the name does
 * not say.
 */
export function quantBitsFromName(path: string): number | null {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  const q = /(?:^|[-_.])(?:ud-)?i?q(\d)(?:_|[-.]|$)/.exec(name);
  if (q) return Number(q[1]);
  const tq = /(?:^|[-_.])tq(\d)_/.exec(name);
  if (tq) return Number(tq[1]);
  const fp = /(?:^|[-_.])mxfp(\d)(?:[-_.]|$)/.exec(name);
  if (fp) return Number(fp[1]);
  if (/(?:^|[-_.])(?:bf16|f16|fp16)(?:[-_.]|$)/.test(name)) return 16;
  return null;
}

/**
 * Share of the weights a token reads: `30B-A3B` → 0.1 for a
 * mixture-of-experts model named that way, 1 otherwise (dense, or not
 * known, which is the slow and so the safe assumption).
 */
export function activeShareFromName(name: string): number {
  const m = /(\d+(?:\.\d+)?)b[-_]a(\d+(?:\.\d+)?)b/i.exec(name);
  if (!m) return 1;
  const total = Number(m[1]);
  const active = Number(m[2]);
  if (!(total > 0) || !(active > 0) || active >= total) return 1;
  return active / total;
}

/** Decimal GB of a file, the unit `MachineForModels` uses. */
export function weightsGbOf(sizeBytes: number): number {
  return sizeBytes / BYTES_PER_GB;
}

/** Whether `weightsGb` of weights fits this machine, and where. */
export function quantFitFor(weightsGb: number, machine: MachineForModels): QuantFit {
  if (
    !machine.cpuOnly &&
    machine.gpuBudgetGb !== null &&
    weightsGb <= machine.gpuBudgetGb * GPU_WEIGHTS_SHARE
  ) {
    return { tier: "fits", label: "Fits well", placement: "gpu" };
  }
  const noGpu = machine.cpuOnly || machine.gpuBudgetGb === null;
  if (noGpu && Math.ceil(weightsGb * 1.5) + 2 <= machine.ramGb) {
    // Nothing to offload to (or nothing known): RAM is the whole story.
    return { tier: "fits", label: "Fits well", placement: "ram" };
  }
  if (Math.ceil(weightsGb * 1.2) <= machine.ramGb) {
    return { tier: "tight", label: "Tight fit", placement: "ram" };
  }
  return { tier: "too-big", label: "Too big", placement: "disk" };
}

/** `~25 tok/s, estimate`. */
export function formatSpeedEstimate(tokPerSec: number): string {
  if (tokPerSec < 1) return "under 1 tok/s, estimate";
  return `~${roundTokPerSec(tokPerSec)} tok/s, estimate`;
}

function roundTokPerSec(t: number): number {
  if (t < 10) return Math.round(t);
  if (t < 100) return Math.round(t / 5) * 5;
  return Math.round(t / 10) * 10;
}

/**
 * Rough decode speed for `weightsGb` of weights on this machine, or
 * `null` when there is nothing honest to say (no bandwidth known, or
 * the weights only run paged from disk).
 */
export function forecastDecodeSpeed(input: {
  weightsGb: number;
  /** `activeShareFromName`; 1 for a dense model. */
  activeShare?: number;
  machine: MachineForModels;
  fit?: QuantFit;
}): SpeedForecast | null {
  const { weightsGb, machine } = input;
  const bandwidth: MemoryBandwidth | undefined = machine.bandwidth;
  if (!bandwidth || !(weightsGb > 0)) return null;
  const fit = input.fit ?? quantFitFor(weightsGb, machine);
  if (fit.placement === "disk") return null;

  const share = input.activeShare ?? 1;
  const perTokenGb =
    share < 1 ? (weightsGb * share) / MOE_ROUTING_EFFICIENCY : weightsGb;

  const ramRate = bandwidth.ramGbPerSec * CPU_DECODE_EFFICIENCY;
  let secondsPerToken: number;
  if (bandwidth.unified && bandwidth.gpuGbPerSec !== null) {
    // One pool: a tight fit on a Mac is slower to load, not to read.
    secondsPerToken = perTokenGb / (bandwidth.gpuGbPerSec * UNIFIED_DECODE_EFFICIENCY);
  } else if (
    bandwidth.gpuGbPerSec === null ||
    machine.cpuOnly ||
    machine.gpuBudgetGb === null
  ) {
    secondsPerToken = perTokenGb / ramRate;
  } else {
    // Discrete GPU: what fits in its share is read from VRAM, the rest
    // from system RAM by the CPU, and the slow part dominates.
    const inGpuGb = Math.min(weightsGb, machine.gpuBudgetGb * GPU_WEIGHTS_SHARE);
    const gpuFraction = weightsGb > 0 ? inGpuGb / weightsGb : 0;
    const gpuRate = bandwidth.gpuGbPerSec * GPU_DECODE_EFFICIENCY;
    secondsPerToken =
      (perTokenGb * gpuFraction) / gpuRate +
      (perTokenGb * (1 - gpuFraction)) / ramRate;
  }
  if (!(secondsPerToken > 0)) return null;
  const tokPerSec = 1 / secondsPerToken;
  return {
    tokPerSec: Math.round(tokPerSec * 10) / 10,
    label: formatSpeedEstimate(tokPerSec),
  };
}

/** What `rateQuantChoices` adds to each choice. */
export interface QuantRating {
  bits: number | null;
  fit: QuantFit;
  speed: SpeedForecast | null;
}

export function rateQuant(
  file: { path: string; sizeBytes: number },
  machine: MachineForModels,
  modelName?: string,
): QuantRating {
  const weightsGb = weightsGbOf(file.sizeBytes);
  const fit = quantFitFor(weightsGb, machine);
  const activeShare = activeShareFromName(`${modelName ?? ""} ${file.path}`);
  return {
    bits: quantBitsFromName(file.path),
    fit,
    speed: forecastDecodeSpeed({ weightsGb, activeShare, machine, fit }),
  };
}

/**
 * Index of the quant to offer first, or `null` when none qualifies:
 *  1. among the 4-bit-or-more quants that fit the GPU (or the RAM of a
 *     machine without one) and answer at a pleasant speed, the most
 *     precise one (the larger file breaks a tie);
 *  2. else the fastest of the ones that fit;
 *  3. else the smallest 4-bit-or-more quant that is a tight fit;
 *  4. else nothing — never a 2- or 3-bit file, never one that only runs
 *     from disk.
 * A quant whose bit level the name does not give is not picked: it may
 * be below 4-bit.
 */
export function pickBestQuant(
  rated: readonly (QuantRating & { sizeBytes: number })[],
): number | null {
  const eligible = rated
    .map((r, index) => ({ r, index }))
    .filter(({ r }) => r.bits !== null && r.bits >= MIN_AUTO_PICK_BITS);

  const fits = eligible.filter(({ r }) => r.fit.tier === "fits");
  const pleasant = fits.filter(
    ({ r }) => r.speed === null || r.speed.tokPerSec >= PLEASANT_TOK_PER_SEC,
  );
  if (pleasant.length > 0) {
    return pleasant.reduce((best, cur) =>
      cur.r.bits! > best.r.bits! ||
      (cur.r.bits === best.r.bits && cur.r.sizeBytes > best.r.sizeBytes)
        ? cur
        : best,
    ).index;
  }
  if (fits.length > 0) {
    return fits.reduce((best, cur) => (cur.r.sizeBytes < best.r.sizeBytes ? cur : best))
      .index;
  }
  const tight = eligible.filter(({ r }) => r.fit.tier === "tight");
  if (tight.length > 0) {
    return tight.reduce((best, cur) => (cur.r.sizeBytes < best.r.sizeBytes ? cur : best))
      .index;
  }
  return null;
}
