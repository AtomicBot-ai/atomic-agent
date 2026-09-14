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

// ---------------------------------------------------------------------
// KV cost from the model's own layout.
//
// The cache is one K and one V vector per token per attention layer,
// `n_head_kv × head_dim` values each, at the cache type's bits per
// value. Every layer with sliding-window attention keeps only the last
// `window` tokens, so past `window` its cost per token of context falls
// as `window / ctx`; a recurrent (SSM / linear-attention) layer keeps a
// fixed state and costs nothing per token. That is why Gemma 4 31B — 60
// layers, 50 of them sliding — measures 13.7 KB per token at 131,072
// where a dense model of its size would need several times that, and
// why any figure taken from the file size alone was 4-40× off.
// ---------------------------------------------------------------------

/** llama.cpp `--cache-type-k/-v` values the managed daemon may run with. */
export type KvCacheType =
  | "turbo3"
  | "turbo4"
  | "q4_0"
  | "q4_1"
  | "q5_0"
  | "q5_1"
  | "q8_0"
  | "f16"
  | "bf16"
  | "f32";

/**
 * Bits per cached value, block overhead included. TurboQuant's 3-bit
 * cache carries a per-block scale, hence ≈ 3.5; `q8_0` is 8 bits plus
 * an f16 scale per 32 values (8.5); the float types are exact. An
 * unknown type is costed as f16 — the safe direction for a fit.
 */
export const KV_CACHE_BITS_PER_VALUE: Record<KvCacheType, number> = {
  turbo3: 3.5,
  turbo4: 4.5,
  q4_0: 4.5,
  q4_1: 5,
  q5_0: 5.5,
  q5_1: 6,
  q8_0: 8.5,
  f16: 16,
  bf16: 16,
  f32: 32,
};

/** The cache type the managed launch flags use (`daemon-lifecycle.ts`). */
export const MANAGED_KV_CACHE_TYPE: KvCacheType = "turbo3";

export function kvBitsPerValue(cacheType: KvCacheType | string): number {
  return (
    KV_CACHE_BITS_PER_VALUE[cacheType as KvCacheType] ??
    KV_CACHE_BITS_PER_VALUE.f16
  );
}

export type KvLayerKind = "global" | "swa" | "recurrent";

export interface KvLayer {
  kind: KvLayerKind;
  /** KV heads on this layer (`attention.head_count_kv`, per layer). */
  headCountKv: number;
  /** Key head dimension (`attention.key_length`, or its `_swa` twin). */
  keyLength: number;
  /** Value head dimension (`attention.value_length`, or its `_swa` twin). */
  valueLength: number;
}

/** What the KV estimate needs to know about a model, layer by layer. */
export interface KvCacheLayout {
  layers: readonly KvLayer[];
  /** Sliding-window width in tokens for the `swa` layers (`0`: none). */
  slidingWindow: number;
}

/**
 * The GGUF metadata fields the layout is built from — the shape the
 * header reader (`gguf-metadata.ts`) hands over, kept as plain numbers
 * so a test can state a model by hand.
 */
export interface KvLayoutSource {
  blockCount: number;
  /** One count for every layer, or one per layer (Gemma 4 alternates). */
  headCountKv: number | readonly number[];
  keyLength: number;
  valueLength: number;
  slidingWindow?: number | null;
  /**
   * `true` on the layers that use the sliding window. Absent with a
   * positive `slidingWindow`: every layer slides — the conservative
   * reading for reuse, the optimistic one for memory, which is why a
   * pattern is preferred whenever the header carries one.
   */
  slidingWindowPattern?: readonly boolean[] | null;
  /** Head dims of the sliding layers when they differ (Gemma 4: 256 vs 512). */
  keyLengthSwa?: number | null;
  valueLengthSwa?: number | null;
  /**
   * Hybrid models (`qwen35`, `nemotron_h`, …): every N-th layer is full
   * attention, the rest are recurrent and keep no per-token cache.
   */
  fullAttentionInterval?: number | null;
  /** Explicit per-layer recurrent flags, when the header states them. */
  recurrentLayerPattern?: readonly boolean[] | null;
}

export function buildKvLayout(source: KvLayoutSource): KvCacheLayout {
  const window =
    typeof source.slidingWindow === "number" && source.slidingWindow > 0
      ? source.slidingWindow
      : 0;
  const layers: KvLayer[] = [];
  for (let i = 0; i < source.blockCount; i += 1) {
    const heads =
      typeof source.headCountKv === "number"
        ? source.headCountKv
        : (source.headCountKv[i] ?? source.headCountKv[0] ?? 0);
    const recurrent =
      source.recurrentLayerPattern?.[i] ??
      (typeof source.fullAttentionInterval === "number" &&
      source.fullAttentionInterval > 1
        ? (i + 1) % source.fullAttentionInterval !== 0
        : false);
    const slides =
      window > 0 &&
      (source.slidingWindowPattern ? source.slidingWindowPattern[i] === true : true);
    const kind: KvLayerKind = recurrent ? "recurrent" : slides ? "swa" : "global";
    layers.push({
      kind,
      headCountKv: heads,
      keyLength:
        kind === "swa" ? (source.keyLengthSwa ?? source.keyLength) : source.keyLength,
      valueLength:
        kind === "swa"
          ? (source.valueLengthSwa ?? source.valueLength)
          : source.valueLength,
    });
  }
  return { layers, slidingWindow: window };
}

function layerBytesPerToken(layer: KvLayer, bitsPerValue: number): number {
  return (layer.headCountKv * (layer.keyLength + layer.valueLength) * bitsPerValue) / 8;
}

export interface KvEstimateOptions {
  /**
   * `--swa-full`: the sliding layers keep the whole context like a
   * global layer would — what buys them prefix reuse.
   */
  swaFull?: boolean;
}

/**
 * Bytes of KV cache a context of `ctx` tokens costs in total, for the
 * cache type given — `Σ ctx × bytes(layer)` over the global layers plus
 * `Σ min(window, ctx) × bytes(layer)` over the sliding ones, nothing for
 * recurrent ones.
 */
export function estimateKvBytesTotal(
  layout: KvCacheLayout,
  cacheType: KvCacheType | string,
  ctx: number,
  options: KvEstimateOptions = {},
): number {
  const bits = kvBitsPerValue(cacheType);
  let total = 0;
  for (const layer of layout.layers) {
    if (layer.kind === "recurrent") continue;
    const perToken = layerBytesPerToken(layer, bits);
    const tokens =
      layer.kind === "swa" && !options.swaFull
        ? Math.min(layout.slidingWindow, ctx)
        : ctx;
    total += tokens * perToken;
  }
  return total;
}

/**
 * Average bytes of KV per token of context at `ctx`. Sliding layers are
 * weighted by `min(window, ctx) / ctx`, so the figure depends on the
 * context it is quoted for: Gemma 4 31B costs ~19 KB/token at 131,072
 * with turbo3 (measured: 13.7) and far more at 4,096.
 */
export function estimateKvBytesPerToken(
  layout: KvCacheLayout,
  cacheType: KvCacheType | string,
  ctx: number,
  options: KvEstimateOptions = {},
): number {
  if (!(ctx > 0)) return 0;
  return estimateKvBytesTotal(layout, cacheType, ctx, options) / ctx;
}

/** Layer counts the `--swa-full` decision reasons about. */
export function countKvLayers(layout: KvCacheLayout): {
  total: number;
  global: number;
  swa: number;
  recurrent: number;
} {
  let global = 0;
  let swa = 0;
  let recurrent = 0;
  for (const layer of layout.layers) {
    if (layer.kind === "global") global += 1;
    else if (layer.kind === "swa") swa += 1;
    else recurrent += 1;
  }
  return { total: layout.layers.length, global, swa, recurrent };
}

// ---------------------------------------------------------------------
// The fallback when no header could be read.
// ---------------------------------------------------------------------

/**
 * Conservative KV-cache cost per token, expressed per GB of model file
 * size so it scales with model depth/width. **Fallback only**: used when
 * the model's GGUF header could not be read and no `KvCacheLayout` is
 * known; the layout-based estimate above is the normal path.
 *
 * Calibrated on Gemma 4 31B QAT UD-Q4_K_XL (17.29 GB) under the managed
 * launch flags on a 64 GB M1 Max: ≈ 13.7 KB per token measured, 3,200
 * B/GB costs it ~55 KB — about 4× the measurement, on purpose, because
 * a scale from one file size is a guess. A dense 32B-class model with
 * full attention on every layer (64 layers × 8 KV heads × 128 dims,
 * ~19.8 GB at Q4) needs ~63 KB per token at 3.5 bits, which the scale
 * just covers.
 */
export const KV_BYTES_PER_TOKEN_PER_GB = 3_200;

/**
 * Floor on the fallback per-token estimate, whatever the file size:
 * small dense models have the deepest cache per GB (an 8B-class model,
 * 36 layers × 8 KV heads × 128 dims, ~5 GB at Q4, holds ~35 KB per token
 * at 3.5 bits where 3,200 B/GB alone would credit it with 16 KB).
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
export const MIN_AUTO_CONTEXT = 32_768;

/**
 * Upper bound for the auto-sized context: the model's trained context,
 * capped at 262,144. Below it the memory fit decides. It was 131,072,
 * and 32,768 before that; with the KV cost read from the model's own
 * layout the fit is honest enough to let a big unified-memory machine
 * use what the model was trained for. The model's trained ceiling still
 * clamps it, and operators who want a different number pin
 * `localModels.managed.contextSize`.
 */
export const MAX_AUTO_CONTEXT = 262_144;

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
  /**
   * The model's attention layout from its GGUF header. When known, the
   * KV cost is computed from it; `null` / absent falls back to the
   * file-size scale.
   */
  kvLayout?: KvCacheLayout | null;
  /** Cache type the daemon launches with. Defaults to the managed flags'. */
  cacheType?: KvCacheType | string;
  /** Whether the launch carries `--swa-full` (sliding layers at full size). */
  swaFull?: boolean;
}

function roundDownTo(value: number, step: number): number {
  return Math.max(step, Math.floor(value / step) * step);
}

/**
 * The KV budget (MiB) a launch has after weights, projector and compute
 * buffers — the memory the context is fitted into. Negative when the
 * weights alone do not fit.
 */
export function resolveKvBudgetMiB(input: {
  freeVramMiB: number;
  modelSizeGb: number;
  mmprojSizeGb: number;
}): number {
  const usableMiB = input.freeVramMiB * VRAM_SAFETY_FRACTION;
  const weightsMiB = (input.modelSizeGb + input.mmprojSizeGb) * MIB_PER_GB;
  return usableMiB - weightsMiB - COMPUTE_OVERHEAD_MIB;
}

/**
 * The largest context whose KV cache fits `budgetBytes`, from the layout.
 * `total(ctx)` is monotone in `ctx`: linear past the window, so the
 * closed form is exact there; below it the sliding layers cost like
 * global ones.
 */
export function fitContextToKvBudget(
  layout: KvCacheLayout,
  cacheType: KvCacheType | string,
  budgetBytes: number,
  options: KvEstimateOptions = {},
): number {
  if (!(budgetBytes > 0)) return 0;
  const bits = kvBitsPerValue(cacheType);
  let globalPerToken = 0;
  let swaPerToken = 0;
  for (const layer of layout.layers) {
    if (layer.kind === "recurrent") continue;
    const perToken = layerBytesPerToken(layer, bits);
    if (layer.kind === "swa" && !options.swaFull) swaPerToken += perToken;
    else globalPerToken += perToken;
  }
  const window = layout.slidingWindow;
  const allPerToken = globalPerToken + swaPerToken;
  if (allPerToken <= 0) return Number.POSITIVE_INFINITY;
  // Below the window every layer scales with ctx.
  const belowWindow = budgetBytes / allPerToken;
  if (swaPerToken === 0 || belowWindow <= window) return Math.floor(belowWindow);
  // Past it the sliding layers are a constant `window × swaPerToken`.
  if (globalPerToken <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor((budgetBytes - window * swaPerToken) / globalPerToken);
}

/**
 * Resolve the effective `--ctx-size` for a managed chat daemon. Pure —
 * all IO (VRAM probe, catalog lookup, header read) happens in the
 * caller. When `configuredContextSize > 0` the operator's value wins
 * (clamped to the model ceiling). Otherwise the size is fitted to free
 * VRAM: weights + projector + compute overhead are subtracted, and the
 * remainder is what the KV cache may take — costed from the model's
 * layout when the header was readable, from the file-size scale when
 * not — then clamped into `[MIN_AUTO_CONTEXT, MAX_AUTO_CONTEXT]` and the
 * model's trained ceiling.
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

  const kvBudgetMiB = resolveKvBudgetMiB({
    freeVramMiB,
    modelSizeGb,
    mmprojSizeGb,
  });
  const kvBudgetBytes = kvBudgetMiB > 0 ? kvBudgetMiB * 1024 * 1024 : 0;

  let fitTokens: number;
  if (input.kvLayout && input.kvLayout.layers.length > 0) {
    fitTokens = fitContextToKvBudget(
      input.kvLayout,
      input.cacheType ?? MANAGED_KV_CACHE_TYPE,
      kvBudgetBytes,
      { swaFull: input.swaFull === true },
    );
  } else {
    const kvBytesPerToken = Math.max(
      KV_MIN_BYTES_PER_TOKEN,
      modelSizeGb * KV_BYTES_PER_TOKEN_PER_GB,
    );
    fitTokens = kvBudgetBytes / kvBytesPerToken;
  }

  const clamped = Math.min(
    MAX_AUTO_CONTEXT,
    Math.max(MIN_AUTO_CONTEXT, Math.floor(Math.min(fitTokens, MAX_AUTO_CONTEXT))),
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
