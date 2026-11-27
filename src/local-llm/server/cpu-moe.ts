import type { GgufMetadata } from "../catalog/gguf-metadata.js";

/**
 * `localModels.managed.cpuMoe` (ATO-2380): keep the expert weights of a
 * mixture-of-experts model in system RAM and run them on the CPU, while
 * attention, the shared layers and the KV cache stay on the GPU. This is
 * llama.cpp's `--n-cpu-moe N` (the experts of the first N layers stay on
 * the CPU). A 30B-A3B model reads only ~3B weights a token, so the CPU
 * side costs far less than leaving whole layers there.
 *
 *   - `"auto"` (default): only when the model does not fit the GPU's
 *     free memory, on a GPU with memory of its own; N is the fewest
 *     layers whose experts free enough of it. A model that fits, a dense
 *     model, Apple silicon (one memory for both) and CPU-only launches
 *     get no flag, so their launch stays byte-identical.
 *   - `"off"`: never.
 *   - a whole number 1..512: exactly that many layers, on any MoE model.
 *
 * Precedent: LM Studio "Force MoE weights onto CPU", Jan's `--n-cpu-moe`
 * engine setting.
 */
export type CpuMoePreference = "auto" | "off" | number;

export const CPU_MOE_DEFAULT: CpuMoePreference = "auto";
export const CPU_MOE_MAX_PINNED_LAYERS = 512;

/** Kept free on the GPU beyond the estimate: the figures are estimates. */
export const CPU_MOE_MARGIN_BYTES = 512 * 1024 * 1024;

/** Vocabulary assumed when the header does not say (a large one). */
const FALLBACK_VOCAB = 152_064;

export function isCpuMoePreference(value: unknown): value is CpuMoePreference {
  return (
    value === "auto" ||
    value === "off" ||
    (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= CPU_MOE_MAX_PINNED_LAYERS)
  );
}

/** What the header says about a mixture-of-experts model. */
export interface MoeShape {
  blockCount: number;
  /** Leading layers without experts (DeepSeek / GLM `leading_dense_block_count`). */
  leadingDenseLayers: number;
  expertCount: number;
  /** Estimated bytes of expert weights in one MoE layer of this file. */
  expertBytesPerLayer: number;
}

function keyNumber(meta: GgufMetadata, suffix: string): number | null {
  const v = meta.keys[`${meta.architecture}.${suffix}`];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * The MoE shape from the GGUF header, or `null` for a dense model or a
 * header that does not say enough. The expert share of the file is
 * estimated from the parameter counts the header gives (experts, their
 * width, the model width, the vocabulary) and applied to the file size,
 * so it follows the file's own quantization.
 */
export function moeShapeFromMetadata(meta: GgufMetadata, fileBytes: number): MoeShape | null {
  const expertCount = keyNumber(meta, "expert_count");
  const blockCount = meta.blockCount;
  const d = meta.embeddingLength;
  if (expertCount === null || expertCount < 2 || !blockCount || !d || fileBytes <= 0) return null;
  const expertFf = keyNumber(meta, "expert_feed_forward_length") ?? keyNumber(meta, "feed_forward_length");
  if (expertFf === null) return null;
  const leadingDenseLayers = Math.min(
    blockCount - 1,
    Math.floor(keyNumber(meta, "leading_dense_block_count") ?? 0),
  );
  const moeLayers = blockCount - leadingDenseLayers;
  const sharedFf =
    (keyNumber(meta, "expert_shared_feed_forward_length") ?? 0) *
    (keyNumber(meta, "expert_shared_count") ?? (keyNumber(meta, "expert_shared_feed_forward_length") ? 1 : 0));
  const denseFf = keyNumber(meta, "feed_forward_length") ?? expertFf;
  const vocab = meta.arrayLengths?.["tokenizer.ggml.tokens"] ?? FALLBACK_VOCAB;

  const expertParamsPerLayer = 3 * expertCount * d * expertFf;
  // Attention (q, k, v, o ~ 4·d²), the router and any shared expert.
  const sharedParamsPerLayer = 4 * d * d + expertCount * d + 3 * d * sharedFf;
  const totalParams =
    moeLayers * (expertParamsPerLayer + sharedParamsPerLayer) +
    leadingDenseLayers * (4 * d * d + 3 * d * denseFf) +
    2 * vocab * d;
  const bytesPerParam = fileBytes / totalParams;
  return {
    blockCount,
    leadingDenseLayers,
    expertCount,
    expertBytesPerLayer: Math.floor(expertParamsPerLayer * bytesPerParam),
  };
}

export interface CpuMoeDecisionInput {
  preference: CpuMoePreference;
  /** `null`: dense model or unreadable header. */
  shape: MoeShape | null;
  /** The resolved device; `"cpu"` offloads nothing. */
  device: string | undefined;
  /** The device is Apple silicon or an integrated GPU (one memory for both). */
  sharesSystemMemory: boolean;
  /**
   * Free device memory left after weights, projector and compute reserve
   * (`resolveEffectiveContextSize().deviceBudgetBytes`); negative when the
   * weights alone overflow it, `null` when unknown.
   */
  deviceBudgetBytes: number | null;
  /** The KV cache this launch's context takes on the device. */
  kvBytes: number;
}

export interface CpuMoeDecision {
  /** `--n-cpu-moe` value; 0 means no flag. */
  layers: number;
  /** One line for the daemon log. */
  reason: string;
}

export function decideCpuMoeLayers(input: CpuMoeDecisionInput): CpuMoeDecision {
  const { preference, shape } = input;
  if (preference === "off") return { layers: 0, reason: "cpu-moe: off" };
  if (input.device === "cpu") return { layers: 0, reason: "cpu-moe: not used, CPU-only launch" };
  if (shape === null) return { layers: 0, reason: "cpu-moe: not used, not a mixture-of-experts model" };
  if (typeof preference === "number") {
    const layers = Math.min(preference, shape.blockCount);
    return { layers, reason: `cpu-moe: experts of the first ${layers} layers on the CPU (pinned)` };
  }
  if (input.sharesSystemMemory) {
    return { layers: 0, reason: "cpu-moe: not used, the GPU shares system memory" };
  }
  if (input.deviceBudgetBytes === null) {
    return { layers: 0, reason: "cpu-moe: not used, free GPU memory unknown" };
  }
  const shortBytes = input.kvBytes + CPU_MOE_MARGIN_BYTES - input.deviceBudgetBytes;
  if (shortBytes <= 0) return { layers: 0, reason: "cpu-moe: not needed, the model fits the GPU" };
  if (shape.expertBytesPerLayer <= 0) {
    return { layers: 0, reason: "cpu-moe: not used, expert size unknown" };
  }
  const moeLayers = Math.ceil(shortBytes / shape.expertBytesPerLayer);
  const layers = Math.min(shape.blockCount, shape.leadingDenseLayers + moeLayers);
  const gib = (b: number): string => (b / 1024 ** 3).toFixed(1);
  return {
    layers,
    reason:
      `cpu-moe: experts of the first ${layers}/${shape.blockCount} layers on the CPU ` +
      `(GPU short by ~${gib(shortBytes)} GiB, ~${gib(shape.expertBytesPerLayer)} GiB of experts per layer, estimated)`,
  };
}

/**
 * The one retry a failed launch gets when `"auto"` chose the experts'
 * layers (review M1): the estimate can be short, and llama.cpp's own fit
 * does not adjust a launch that already overrides tensor placement. The
 * retry runs without the flag (`cpuMoe: "off"`), which is the launch the
 * model had before ATO-2380. `null`: no retry (no flag, a pinned count,
 * `"off"`, or the caller cancelled).
 */
export function cpuMoeRetryOptions<T extends { cpuMoe?: CpuMoePreference; signal?: AbortSignal }>(
  opts: T,
  layers: number,
  err: unknown,
): (T & { cpuMoe: "off" }) | null {
  if (layers <= 0) return null;
  if ((opts.cpuMoe ?? "auto") !== "auto") return null;
  if (opts.signal?.aborted) return null;
  if (err instanceof Error && err.name === "AbortError") return null;
  return { ...opts, cpuMoe: "off" };
}

export const CPU_MOE_RETRY_NOTE =
  "[atomic-agent] launch: cpu-moe: the load with experts on the CPU failed; retrying once without --n-cpu-moe\n";
