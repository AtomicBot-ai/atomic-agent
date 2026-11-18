/**
 * What a task should cost on a priced (cloud) leg, before it is sent
 * (ATO-1585).
 *
 * Spend used to be known only after the answer (`estimateUsageCostUsd`
 * over the reported usage). This is the forecast from the three things
 * known up front: the planner's estimate of the task's output
 * (`outputTokens` / `outputLines`, ATO-1363), the brief's length and the
 * leg's price. It is a rough number and says so ("est"); after the task
 * the row shows it beside the actual spend, the way ATO-1363 shows the
 * size estimate beside the tokens written. Nothing is refused on it: it
 * is an input for the placement rule (F2-10.3), not a gate.
 *
 * The model of a worker turn, kept deliberately simple:
 * - every step sends the worker frame, its tool catalog and the brief
 *   (`WORKER_FRAME_TOKENS` + brief chars / 4), plus what it has written
 *   so far, which grows linearly to the full output;
 * - the output is written over `ceil(output / OUTPUT_TOKENS_PER_STEP)`
 *   steps (at least one, at most `MAX_ESTIMATED_STEPS`);
 * - the prompt prefix seen once is billed at the input rate, every
 *   repeat at the cache-read rate (the provider's prompt cache).
 */

import { estimateUsageCostUsd } from "../../llm/provider/usage-cost.js";
import { estimatedOutputTokens, type OutputEstimate } from "./worker-fit.js";
import type { WorkerPricing } from "./worker-result.js";

/** The worker frame and builder tool catalog a step resends, in tokens. */
export const WORKER_FRAME_TOKENS = 4_000;
/** Rough characters per token of an English brief. */
export const BRIEF_CHARS_PER_TOKEN = 4;
/** Output a worker writes in one step (one file write or edit). */
export const OUTPUT_TOKENS_PER_STEP = 800;
/** The worker step budget's default (`DEFAULT_FUSION_WORKER_MAX_STEPS`). */
export const MAX_ESTIMATED_STEPS = 60;

export interface CostEstimateInput extends OutputEstimate {
  /** Brief length: instructions + deliverable, in characters. */
  briefChars: number;
}

/**
 * The forecast in USD, or `null` when it cannot be made: no price (a
 * local leg, an unpriced model) or no output estimate on the task.
 */
export function estimateTaskCostUsd(
  task: CostEstimateInput,
  pricing: WorkerPricing | undefined,
): number | null {
  if (pricing === undefined) return null;
  const output = estimatedOutputTokens(task);
  if (output === null) return null;
  const base =
    WORKER_FRAME_TOKENS +
    Math.ceil(Math.max(0, task.briefChars) / BRIEF_CHARS_PER_TOKEN);
  const steps = Math.min(
    MAX_ESTIMATED_STEPS,
    Math.max(1, Math.ceil(output / OUTPUT_TOKENS_PER_STEP)),
  );
  // Σ over steps of (base + output written before that step).
  const promptTokens = steps * base + Math.round((output * (steps - 1)) / 2);
  // Seen once: the base and the output; everything else is a repeat.
  const firstSeen = Math.min(promptTokens, base + output);
  const usd = estimateUsageCostUsd(
    {
      promptTokens,
      cachedTokens: promptTokens - firstSeen,
      completionTokens: output,
      totalTokens: promptTokens + output,
    },
    pricing,
  );
  return Number.isFinite(usd) ? usd : null;
}

/** `$0.04`, or four decimals under a cent, like the status table. */
export function formatEstimateUsd(usd: number): string {
  return usd < 0.01 && usd > 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** The row note: `cost: ≈$0.04 est, $0.05 actual`. */
export function describeCostEstimate(
  estimateUsd: number,
  actualUsd: number | null,
): string {
  const actual =
    actualUsd === null ? "" : `, ${formatEstimateUsd(actualUsd)} actual`;
  return `cost: ≈${formatEstimateUsd(estimateUsd)} est${actual}`;
}
