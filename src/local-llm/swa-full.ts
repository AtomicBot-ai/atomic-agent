import {
  buildKvLayout,
  countKvLayers,
  estimateKvBytesPerToken,
  MANAGED_KV_CACHE_TYPE,
  type KvCacheType,
  type KvLayoutSource,
} from "./context-size.js";

/**
 * `localModels.managed.swaFull`: whether the managed daemon launches a
 * sliding-window model with `--swa-full`.
 *
 * With sliding-window attention llama.cpp keeps only the last `window`
 * tokens of those layers' KV, which is what makes Gemma 4's cache so
 * small — and what makes it reusable only as a whole: a prompt that
 * matched for its first 19 % reused nothing, because the sliding layers
 * cannot be rolled back to the divergence point. `--swa-full` keeps the
 * whole context in those layers too (a global layer's cost), and any
 * prefix becomes reusable again.
 *
 *   - `"on"`  — always, for a model with sliding layers.
 *   - `"off"` — never.
 *   - `"auto"` (default) — when the KV estimate at full SWA fits the
 *     launch's memory budget; otherwise keep the small cache and rely on
 *     the packer's chunked history drops (F10).
 */
export type SwaFullPreference = "auto" | "on" | "off";

export const SWA_FULL_PREFERENCES: readonly SwaFullPreference[] = [
  "auto",
  "on",
  "off",
];

export function isSwaFullPreference(
  value: unknown,
): value is SwaFullPreference {
  return (
    typeof value === "string" &&
    (SWA_FULL_PREFERENCES as readonly string[]).includes(value)
  );
}

/**
 * The ratio the auto estimate is capped at. A model whose global layers
 * are a small minority (a 1:11 pattern, say) would put full SWA at
 * dozens of times the measured cost; past 8× the figure is a guess
 * about a layout nobody measured, so it is capped there and flagged.
 */
export const SWA_FULL_MAX_RATIO = 8;

export interface SwaFullDecisionInput {
  preference: SwaFullPreference;
  /** The model's layout from its header; `null` when unreadable. */
  layout: KvLayoutSource | null;
  /** The context the daemon launches with. */
  contextSize: number;
  /**
   * Bytes of memory the KV cache may take (weights, projector and
   * compute buffers already subtracted); `null` when no budget is known
   * (CPU offload, no VRAM figure).
   */
  kvBudgetBytes: number | null;
  cacheType?: KvCacheType | string;
}

export interface SwaFullDecision {
  /** Whether to pass `--swa-full`. */
  enabled: boolean;
  /** One line for the daemon log. */
  reason: string;
  /** Estimated bytes of KV at the launch context, with and without. */
  estimate: {
    swa: number;
    full: number;
    ratio: number;
    capped: boolean;
  } | null;
  slidingLayers: number;
}

/**
 * Decide `--swa-full` for one launch. Pure.
 *
 * The auto estimate follows the fix plan: per-token KV × (total layers
 * / non-sliding layers), capped at `SWA_FULL_MAX_RATIO` — the ratio form
 * rather than the exact all-layers-full figure, because the exact figure
 * has not been measured and the cap is the guard against a layout that
 * would put it at 30×. Flagged as an estimate in the reason line.
 */
/**
 * Share of the KV budget the *full* cache may take before `auto`
 * declines to turn `--swa-full` on.
 *
 * Six tenths, so a full cache has to leave four tenths of the budget
 * unspent. That is the margin the flat `COMPUTE_OVERHEAD_MIB` does not
 * cover once the context is long, and it is cheap to give up: a model
 * whose full cache is that small was never the case where prefix reuse
 * is worth the risk.
 */
export const SWA_FULL_BUDGET_SHARE = 0.6;

export function resolveSwaFullDecision(
  input: SwaFullDecisionInput,
): SwaFullDecision {
  if (input.layout === null) {
    return {
      enabled: false,
      reason: "swa-full: off — model header unreadable, layout unknown",
      estimate: null,
      slidingLayers: 0,
    };
  }
  const layout = buildKvLayout(input.layout);
  const counts = countKvLayers(layout);
  if (counts.swa === 0) {
    return {
      enabled: false,
      reason: "swa-full: not applicable — no sliding-window layers",
      estimate: null,
      slidingLayers: 0,
    };
  }
  const cacheType = input.cacheType ?? MANAGED_KV_CACHE_TYPE;
  const ctx = Math.max(1, input.contextSize);
  const perTokenSwa = estimateKvBytesPerToken(layout, cacheType, ctx);
  const nonSliding = Math.max(1, counts.total - counts.swa);
  const rawRatio = counts.total / nonSliding;
  const capped = rawRatio > SWA_FULL_MAX_RATIO;
  const ratio = capped ? SWA_FULL_MAX_RATIO : rawRatio;
  const estimate = {
    swa: perTokenSwa * ctx,
    full: perTokenSwa * ratio * ctx,
    ratio,
    capped,
  };
  const layers = `${counts.swa} of ${counts.total} layers slide`;
  const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;
  const figures =
    `estimate: KV ${gb(estimate.swa)} with SWA, ~${gb(estimate.full)} full ` +
    `(×${ratio.toFixed(1)}${capped ? ", capped" : ""}) at ${ctx} tokens`;

  if (input.preference === "off") {
    return {
      enabled: false,
      reason: `swa-full: off (configured) — ${layers}; ${figures}`,
      estimate,
      slidingLayers: counts.swa,
    };
  }
  if (input.preference === "on") {
    return {
      enabled: true,
      reason: `swa-full: on (configured) — ${layers}; ${figures}`,
      estimate,
      slidingLayers: counts.swa,
    };
  }
  if (input.kvBudgetBytes === null) {
    return {
      enabled: false,
      reason: `swa-full: off (auto) — no memory budget known to fit against; ${layers}; ${figures}`,
      estimate,
      slidingLayers: counts.swa,
    };
  }
  // Headroom, not equality. `kvBudgetBytes` is already 92% of free VRAM
  // minus the weights minus a FLAT compute reserve, and that reserve
  // does not hold at long contexts — Metal's own buffers grow with the
  // context and the batch. Spending the whole budget on KV therefore
  // overcommits the GPU rather than filling it.
  //
  // Measured, on a 31B model at its trained 262144: the estimate came
  // back "KV 4.9 GB with SWA, ~29.3 GB full (×6.0)", 29.3 <= 31.9 said
  // yes, and the server then logged
  // `kIOGPUCommandBufferCallbackErrorOutOfMemory` 298 times while
  // staying up and listening — every decode failing with `ret = -3`,
  // every turn coming back with nothing.
  //
  // The asymmetry is the argument for being strict. Turning swa-full on
  // buys prefix reuse across the sliding layers: a latency win.
  // Overcommitting the GPU costs the model entirely. A feature that
  // wants six times the memory has to prove there is room to spare, and
  // the one case it is clearly safe — a cache that was small anyway —
  // is exactly what this threshold keeps.
  const ceiling = input.kvBudgetBytes * SWA_FULL_BUDGET_SHARE;
  const fits = estimate.full <= ceiling;
  return {
    enabled: fits,
    reason: fits
      ? `swa-full: on (auto) — full-SWA estimate fits ${gb(ceiling)} of the ${gb(input.kvBudgetBytes)} KV budget; ${layers}; ${figures}`
      : `swa-full: off (auto) — full-SWA estimate needs more than ${gb(ceiling)} of the ${gb(input.kvBudgetBytes)} KV budget; ${layers}; ${figures}`,
    estimate,
    slidingLayers: counts.swa,
  };
}
