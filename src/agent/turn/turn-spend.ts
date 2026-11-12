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
 * does, and the task ends with `stopCause: "cost_ceiling"`.
 *
 * The summary step is one more paid completion, so it is budgeted for
 * (ATO-1472): a normal step runs only while the spend leaves room for
 * it AND for the summary after it, each estimated at what the last step
 * cost (`budgetStepPlan`). Once a single paid step has already pushed
 * the spend to the cap, no further paid call is made: the task closes
 * with the plain spend line and the digest built from its own records.
 * Before that fix a $0.01 cap ended at $0.02, the summary on top.
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

/**
 * Add what a context compaction's summary calls cost (ATO-1322). They
 * are side calls, not step completions, so `recordStepSpend` never sees
 * them; without this a long run that compacts spends past its budget.
 */
export function recordCompactionSpend(
  turn: Pick<TurnLoopState, "spendUsd" | "spendPriced">,
  usd: number,
): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  turn.spendUsd += usd;
  turn.spendPriced = true;
}

/** Whether the spend has reached a ceiling that is set. */
export function costCeilingReached(spendUsd: number, ceilingUsd: number): boolean {
  return ceilingUsd > 0 && spendUsd >= ceilingUsd;
}

/**
 * What the next step may be under a spend ceiling (ATO-1472):
 * - `"work"`: a normal step; the spend leaves room for one more step
 *   and the summary after it;
 * - `"summary"`: the reserved summary step, the last paid call;
 * - `"stop"`: the cap is already reached, so the task closes without
 *   another paid call.
 *
 * `lastStepUsd` is what the model's completions in the previous step
 * cost (every completion it asked for; compaction is not counted). It is
 * the estimate for both the next step and the summary. `0` (first step,
 * or a free local model) reserves nothing, so a budget never stops local
 * work, and a cap reached by compaction alone still gets its summary
 * step, which costs nothing.
 */
export function budgetStepPlan(
  spendUsd: number,
  lastStepUsd: number,
  ceilingUsd: number,
): "work" | "summary" | "stop" {
  if (!(ceilingUsd > 0)) return "work";
  const estimate = Number.isFinite(lastStepUsd) && lastStepUsd > 0 ? lastStepUsd : 0;
  if (costCeilingReached(spendUsd, ceilingUsd)) return estimate > 0 ? "stop" : "summary";
  return spendUsd + 2 * estimate > ceilingUsd ? "summary" : "work";
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
  if (spendUsd < ceilingUsd) {
    // The summary step started with room left for itself (ATO-1472).
    // The closing line names no spend figure: the summary is priced
    // after it is written, and the report card shows the real total.
    const headline = `stopped at the ${formatUsd(ceilingUsd)} budget`;
    return (
      `The spend budget for this task is nearly used up (${formatUsd(spendUsd)} of ${formatUsd(ceilingUsd)}, ` +
      "the rest is kept for this summary). " +
      "This is the final allowed step. Do not call any non-terminal tool. " +
      `Reply now: start with "${headline}", then say what is done, what is not, ` +
      "and that the budget can be raised to continue."
    );
  }
  const headline = costCeilingHeadline(spendUsd, ceilingUsd);
  return (
    `The spend budget for this task is used up (${formatUsd(spendUsd)} of ${formatUsd(ceilingUsd)}). ` +
    "This is the final allowed step. Do not call any non-terminal tool. " +
    `Reply now: start with "${headline}", then say what is done, what is not, ` +
    "and that the budget can be raised to continue."
  );
}
