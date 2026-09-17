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
 * wider KV).
 *
 * Measured, then padded. Gemma 4 31B QAT UD-Q4_K_XL (17.29 GB) under the
 * managed launch flags (`-ngl -1 --flash-attn auto --cache-type-k turbo3
 * --cache-type-v turbo3 -kvu`, no mmproj) on a 64 GB M1 Max: process
 * phys_footprint 1,315 MB at `--ctx-size 32768` and 2,657 MB at
 * `--ctx-size 131072` — +1,342 MB for +98,304 tokens, ≈ 13.7 KB per
 * token (a ~3-bit cache on a mostly sliding-window model). 3,200 B/GB
 * costs that model ~55 KB per token: about 4× the measurement, on
 * purpose, because one model is one data point.
 *
 * The margin is not arbitrary either. A dense 32B-class model with full
 * attention on every layer (64 layers × 8 KV heads × 128 dims, ~19.8 GB
 * at Q4) needs ~63 KB per token at 3.5 bits, and 3,200 × 19.8 GB just
 * covers it — so this is about as low as the scale can go without a
 * measurement on such a model.
 *
 * It was 32,000, calibrated against a 9B model whose KV "fit in ~1 GB at
 * 4096 tokens": ~40× what the 31B really costs, which held a 64 GB Mac to
 * a context that could serve one worker.
 */
export const KV_BYTES_PER_TOKEN_PER_GB = 3_200;

/**
 * Floor on the per-token estimate, whatever the file size.
 *
 * Scaling by file size flatters small *dense* models, which have the
 * deepest cache per GB: an 8B-class model with full attention on every
 * layer (36 layers × 8 KV heads × 128 dims, ~5 GB at Q4) holds ~35 KB per
 * token at 3.5 bits, where 3,200 B/GB alone would credit it with 16 KB —
 * gigabytes short on an 8 GB card once the auto ceiling is 131k. 48 KB
 * clears that shape with room and never binds on a file of 15 GB or more,
 * which includes the model the scale was measured on.
 */
export const KV_MIN_BYTES_PER_TOKEN = 48_000;

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
 * Upper bound for the auto-sized context. Below it the memory fit
 * decides; the bound only keeps auto-sizing from reserving a cache far
 * beyond what a fan-out can use. 131,072 is five ~24k worker footprints
 * (see `worker-slots.ts`) with room to spare — what lets a big
 * unified-memory machine serve several local workers at once.
 *
 * It was 32,768 regardless of free memory. With honest worker footprints
 * that held even a 64 GB Mac running Gemma 4 31B (whose measured KV cost
 * would fit a 131k cache in ~1.8 GB) to exactly one slot. The model's
 * trained ceiling still clamps it, and operators who want a different
 * number pin `localModels.managed.contextSize`.
 */
export const MAX_AUTO_CONTEXT = 131_072;

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

  const kvBytesPerToken = Math.max(
    KV_MIN_BYTES_PER_TOKEN,
    modelSizeGb * KV_BYTES_PER_TOKEN_PER_GB,
  );
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
