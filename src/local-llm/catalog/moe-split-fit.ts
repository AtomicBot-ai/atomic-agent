/**
 * ATO-2455: the catalogue's verdict for a mixture-of-experts model on a
 * GPU with memory of its own, once the managed launch can keep experts
 * in system RAM (`localModels.managed.cpuMoe`, ATO-2380,
 * `../server/cpu-moe.ts`). Such a model runs with attention, the shared
 * layers and the cache on the GPU and the experts that do not fit there
 * on the CPU, so "too big for the GPU" no longer means "too big".
 *
 * Only on positive evidence of a dedicated GPU: a bandwidth estimate
 * whose GPU figure is above the RAM figure. Apple silicon and integrated
 * GPUs (one memory for both, where the launch never adds the flag), a
 * CPU-only machine and a machine nobody probed get no split, so their
 * verdict stays what it was.
 *
 * Pure arithmetic, no runtime imports: `quant-fit.ts` and
 * `model-upgrade.ts` both call it and pass the GPU's weights share in.
 * It lives apart because `quant-fit.ts` imports `model-upgrade.ts`, so
 * the reverse import would be a cycle.
 */

import type { MemoryBandwidth } from "../backend/memory-bandwidth.js";

/** `localModels.managed.cpuMoe`, as the machine facts carry it. */
export type CpuMoeSetting = "auto" | "off" | number;

export interface MoeSplitInput {
  weightsGb: number;
  /** `activeShareFromName`: below 1 only for a name like `35B-A3B`. */
  activeShare: number;
  ramGb: number;
  /** GPU memory the weights may take, decimal GB; `null` without a GPU. */
  gpuWeightsGb: number | null;
  cpuOnly: boolean;
  bandwidth?: MemoryBandwidth;
  /** Absent reads as the default, `"auto"`. */
  cpuMoe?: CpuMoeSetting;
}

export interface MoeSplit {
  /** Expert weights that would sit in system RAM, decimal GB. */
  ramPartGb: number;
  /**
   * The RAM part fits the comfortable envelope an added model gets
   * (`× 1.5 + 2`, `buildCustomModelDef`); otherwise only the tight one
   * (`× 1.2`).
   */
  comfortable: boolean;
}

/**
 * Share of the weights a token reads: `30B-A3B` → 0.1 for a
 * mixture-of-experts model named that way, 1 otherwise (dense, or not
 * known, which is the slow and so the safe assumption).
 * Re-exported by `quant-fit.ts`.
 */
export function activeShareFromName(name: string): number {
  const m = /(\d+(?:\.\d+)?)b[-_]a(\d+(?:\.\d+)?)b/i.exec(name);
  if (!m) return 1;
  const total = Number(m[1]);
  const active = Number(m[2]);
  if (!(total > 0) || !(active > 0) || active >= total) return 1;
  return active / total;
}

/** The GPU has memory of its own, as far as the bandwidth estimate says. */
export function hasDedicatedGpuMemory(bandwidth: MemoryBandwidth | undefined): boolean {
  if (!bandwidth || bandwidth.unified) return false;
  const gpu = bandwidth.gpuGbPerSec;
  return gpu !== null && gpu > bandwidth.ramGbPerSec;
}

/**
 * How a mixture-of-experts model would split between the GPU and system
 * RAM, or `null` when it would not: experts on the CPU turned off, not a
 * mixture of experts, no dedicated GPU, the model fits the GPU whole, the
 * GPU cannot even hold the part every token reads (the active share
 * bounds attention and the shared layers from above), or the RAM cannot
 * hold the rest.
 */
export function moeSplitFor(input: MoeSplitInput): MoeSplit | null {
  if ((input.cpuMoe ?? "auto") === "off") return null;
  if (!(input.activeShare > 0 && input.activeShare < 1)) return null;
  if (input.cpuOnly || !hasDedicatedGpuMemory(input.bandwidth)) return null;
  const gpu = input.gpuWeightsGb;
  if (gpu === null || !(gpu > 0) || !(input.weightsGb > gpu)) return null;
  if (input.weightsGb * input.activeShare > gpu) return null;
  const ramPartGb = input.weightsGb - gpu;
  if (Math.ceil(ramPartGb * 1.5) + 2 <= input.ramGb) return { ramPartGb, comfortable: true };
  if (Math.ceil(ramPartGb * 1.2) <= input.ramGb) return { ramPartGb, comfortable: false };
  return null;
}
