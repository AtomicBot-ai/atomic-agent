import type { CompletionResult } from "../../llm/llama-server-client.js";
import { formatUsd } from "../../llm/provider/usage-cost.js";
import type { TurnLoopState } from "./turn-state.js";

/**
 * The task spend ceiling (ATO-1108): money, next to the step and time
 * ceilings the loop already had.
 *
 * Every completion is priced as soon as it returns (cache-aware,
 * through the runtime's `priceCompletion` seam) and added to the turn's
 * spend, including repair attempts, answer continuations and
 * completions a step then throws away and retries. Before the next step starts, a spend at or over the ceiling
 * makes that step the reserved summary step, exactly as a time ceiling
 * does, and the task ends with `stopCause: "cost_ceiling"`. The summary
 * step itself is one more completion, so a run can end slightly over
 * the cap; it is never cut off mid-edit to save that last call.
 *
 * Unpriced completions (a local model, a provider that reports no
 * usage) count as $0, so a budget never stops local work.
 */
export type PriceCompletion = (
  completion: CompletionResult,
  providerId: string | undefined,
) => number | undefined;

/** The effective ceiling: a positive finite number, or `0` for none. */
export function resolveCostCeilingUsd(
  requested: number | undefined,
  configured: number | undefined,
): number {
  const value = requested ?? configured ?? 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Add one step's completion to the turn's spend. A pricing seam that
 * throws or answers with something that is not a usable amount counts
 * the step as $0: a pricing bug must not end a task.
 */
export function recordStepSpend(
  turn: Pick<TurnLoopState, "spendUsd" | "spendPriced">,
  completion: CompletionResult,
  providerId: string | undefined,
  price: PriceCompletion | undefined,
): void {
  if (price === undefined) return;
  let usd: number | undefined;
  try {
    usd = price(completion, providerId);
  } catch {
    usd = undefined;
  }
  if (usd === undefined || !Number.isFinite(usd) || usd < 0) return;
  turn.spendUsd += usd;
  turn.spendPriced = true;
}

/** Whether the spend has reached a ceiling that is set. */
export function costCeilingReached(spendUsd: number, ceilingUsd: number): boolean {
  return ceilingUsd > 0 && spendUsd >= ceilingUsd;
}

/** The plain closing line both the model and the synthetic stop use. */
export function costCeilingHeadline(spendUsd: number, ceilingUsd: number): string {
  return `stopped: spent ${formatUsd(spendUsd)} of ${formatUsd(ceilingUsd)} budget`;
}

/**
 * The reserved summary step's notice when the spend ceiling, not the
 * step or time ceiling, made it final.
 */
export function costCeilingNotice(spendUsd: number, ceilingUsd: number): string {
  const headline = costCeilingHeadline(spendUsd, ceilingUsd);
  return (
    `The spend budget for this task is used up (${formatUsd(spendUsd)} of ${formatUsd(ceilingUsd)}). ` +
    "This is the final allowed step. Do not call any non-terminal tool. " +
    `Reply now: start with "${headline}", then say what is done, what is not, ` +
    "and that the budget can be raised to continue."
  );
}
