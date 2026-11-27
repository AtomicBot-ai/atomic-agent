import type { CpuMoePreference, MoeShape } from "./cpu-moe.js";

/**
 * ATO-2455: the auto window once experts go to system RAM. The window is
 * fitted first (`resolveEffectiveContextSize`) and the experts decided
 * after it (`decideCpuMoeLayers`), so a mixture-of-experts model that
 * overflows the GPU used to get the floor window (`MIN_AUTO_CONTEXT`)
 * even though the experts it moves free GPU memory for a bigger one.
 *
 * When `"auto"` moved experts for an auto-sized window below
 * {@link CPU_MOE_AUTO_CONTEXT}, the window is fitted again as if every
 * MoE layer's experts sat in RAM (the most the GPU could give the
 * cache), held to {@link CPU_MOE_AUTO_CONTEXT}; the experts are then
 * decided for that window, so `--n-cpu-moe` moves only the layers its
 * cache needs. A growing window (`growContext`) still starts small and
 * may grow up to that ceiling, each growth deciding the layers again.
 *
 * The ceiling is twice the floor and half of `GPU_AUTO_MAX_CONTEXT`:
 * each extra layer of experts on the CPU costs speed, so the window is
 * not pushed to the full GPU cap. A pinned count, `"off"`, a pinned
 * context and a model that fits are left as they were.
 */
export const CPU_MOE_AUTO_CONTEXT = 65_536;

export interface CpuMoeContextRefitInput {
  preference: CpuMoePreference;
  shape: MoeShape | null;
  /** `--n-cpu-moe` the first decision chose for the first window. */
  firstPassLayers: number;
  /** `localModels.managed.contextSize`; 0 or less is auto. */
  configuredContext: number;
  /** The first window. */
  contextSize: number;
}

export interface CpuMoeContextRefit {
  /** Weights, decimal GB, the second fit counts as off the GPU. */
  offDeviceGb: number;
  /** The second fit's ceiling (`autoContextAtMost`). */
  atMost: number;
}

/** Whether to fit the window again with experts in RAM, and how. */
export function cpuMoeContextRefit(input: CpuMoeContextRefitInput): CpuMoeContextRefit | null {
  if (input.preference !== "auto") return null;
  if (input.configuredContext > 0) return null;
  if (input.shape === null || input.firstPassLayers <= 0) return null;
  if (input.contextSize >= CPU_MOE_AUTO_CONTEXT) return null;
  const moeLayers = input.shape.blockCount - input.shape.leadingDenseLayers;
  const offDeviceGb = (input.shape.expertBytesPerLayer * moeLayers) / 1e9;
  if (!(offDeviceGb > 0)) return null;
  return { offDeviceGb, atMost: CPU_MOE_AUTO_CONTEXT };
}
