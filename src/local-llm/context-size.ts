import type { GpuDevice } from "./gpu-devices.js";

/**
 * MiB in one decimal gigabyte. `LocalModelDef.fileSizeGb` is a decimal
 * GB figure (matches on-disk file sizes); VRAM is reported in binary
 * MiB, so weights-vs-VRAM math must convert through this factor.
 */
const MIB_PER_GB = 1_000_000_000 / (1024 * 1024);

/**
 * Fraction of *free* VRAM we are willing to spend. Leaves headroom for
 * allocator fragmentation and the driver's own working set so the fit
 * estimate errs on the safe side (better a smaller context than an OOM
 * at model load).
 */
const VRAM_SAFETY_FRACTION = 0.92;

/**
 * Fixed VRAM reserved for llama.cpp compute buffers (activations, the
 * graph plan, CUDA/Vulkan context) on top of weights + KV. A flat
 * conservative figure — it does not scale much with context length.
 */
const COMPUTE_OVERHEAD_MIB = 768;

/**
 * Conservative KV-cache cost per token, expressed per GB of model file
 * size so it scales with model depth/width (bigger models have deeper,
 * wider KV). Calibrated (with margin) against an observed 9B / ~5.3 GB
 * model whose KV at 4096 tokens fit in ~1 GB of VRAM. Deliberately on
 * the high side so the fit estimate under-allocates rather than OOMs.
 */
const KV_BYTES_PER_TOKEN_PER_GB = 32_000;

/**
 * Lower bound for the auto-sized context. On small GPUs this makes
 * llama.cpp's `-fit` step spill some layers to the CPU (slower) rather
 * than reject every request with HTTP 400.
 *
 * Derived, not arbitrary: the agent's stable prefix (persona + tool
 * catalog + capabilities + instructions) measures ~5.2k tokens on its
 * own, and `localModels.completionMaxTokens` defaults to 8192. The old
 * 8192 floor was therefore *equal to* the generation budget and smaller
 * than prefix + budget combined — a model that landed on it had ~2-3k
 * tokens of room, could not finish a reasoning block plus a tool-call
 * array, and hit llama.cpp's context ceiling with `truncated: true` on
 * every step. Any model >= ~14 GB on a 16 GB card lands on this floor,
 * so the value has to clear 5.2k + 8192 + margin.
 */
export const MIN_AUTO_CONTEXT = 16_384;

/**
 * Upper bound for the auto-sized context. Caps KV growth on large GPUs
 * so auto-sizing never allocates an absurd cache the agent will never
 * fill; operators who want more set `localModels.managed.contextSize`
 * explicitly.
 */
export const MAX_AUTO_CONTEXT = 32_768;

/**
 * Default context when no VRAM figure is available (CPU-only offload or
 * an unknown device). KV lives in system RAM there, which is plentiful,
 * so a moderate fixed value is safe.
 */
export const NO_VRAM_DEFAULT_CONTEXT = 16_384;

export interface EstimateContextSizeInput {
  /**
   * Free VRAM (binary MiB) on the target device, or `null` when there is
   * no GPU budget to fit against (CPU offload / unknown device / macOS
   * unified memory not probed).
   */
  freeVramMiB: number | null;
  /** Model weights file size in decimal GB (`LocalModelDef.fileSizeGb`). */
  modelSizeGb: number;
  /**
   * mmproj projector size in decimal GB, or `0` when the daemon boots
   * text-only (no `--mmproj`).
   */
  mmprojSizeGb: number;
  /** Model's trained context ceiling (`LocalModelDef.maxContextLength`). */
  maxContextLength: number;
  /**
   * Operator override from `localModels.managed.contextSize`. `0` (or a
   * non-positive value) means "auto"; a positive value pins the context
   * exactly, clamped only to the model's trained ceiling.
   */
  configuredContextSize: number;
}

function roundDownTo(value: number, step: number): number {
  return Math.max(step, Math.floor(value / step) * step);
}

/**
 * Resolve the effective `--ctx-size` for a managed chat daemon. Pure —
 * all IO (VRAM probe, catalog lookup) happens in the caller. When
 * `configuredContextSize > 0` the operator's value wins (clamped to the
 * model ceiling). Otherwise the size is fitted to free VRAM: weights +
 * projector + compute overhead are subtracted, the remainder is divided
 * by a per-token KV estimate, and the result is clamped into
 * `[MIN_AUTO_CONTEXT, MAX_AUTO_CONTEXT]` and the model ceiling.
 */
export function estimateContextSize(input: EstimateContextSizeInput): number {
  const {
    freeVramMiB,
    modelSizeGb,
    mmprojSizeGb,
    maxContextLength,
    configuredContextSize,
  } = input;

  const ceiling = maxContextLength > 0 ? maxContextLength : MAX_AUTO_CONTEXT;

  if (configuredContextSize > 0) {
    return Math.min(configuredContextSize, ceiling);
  }

  if (freeVramMiB === null || freeVramMiB <= 0) {
    return Math.min(NO_VRAM_DEFAULT_CONTEXT, ceiling);
  }

  const usableMiB = freeVramMiB * VRAM_SAFETY_FRACTION;
  const weightsMiB = (modelSizeGb + mmprojSizeGb) * MIB_PER_GB;
  const kvBudgetMiB = usableMiB - weightsMiB - COMPUTE_OVERHEAD_MIB;

  const kvBytesPerToken = Math.max(1, modelSizeGb * KV_BYTES_PER_TOKEN_PER_GB);
  const fitTokens =
    kvBudgetMiB > 0 ? (kvBudgetMiB * 1024 * 1024) / kvBytesPerToken : 0;

  const clamped = Math.min(
    MAX_AUTO_CONTEXT,
    Math.max(MIN_AUTO_CONTEXT, Math.floor(fitTokens)),
  );
  return Math.min(roundDownTo(clamped, 1024), ceiling);
}

/**
 * Look up the free VRAM (binary MiB) for the resolved offload device, or
 * `null` when there is no usable figure. Falls back to `totalMemMiB`
 * when the backend reported a total but no free figure. `device` is the
 * value from `resolveManagedDevice`: `"cpu"` / `undefined` yield `null`
 * (no GPU budget); a concrete id matches by `GpuDevice.id`.
 */
export function resolveDeviceFreeVramMiB(
  devices: readonly GpuDevice[],
  device: string | undefined,
): number | null {
  if (!device || device === "cpu") return null;
  const match = devices.find((d) => d.id === device);
  if (!match) return null;
  const free = match.freeMemMiB > 0 ? match.freeMemMiB : match.totalMemMiB;
  return free > 0 ? free : null;
}
