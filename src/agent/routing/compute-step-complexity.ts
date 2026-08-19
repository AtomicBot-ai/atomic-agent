/**
 * Signals available at routing time — i.e. after `buildPrompt` but
 * BEFORE `slotManager.acquire`, because the slot depends on which
 * provider we route to.
 *
 * That ordering is why `cacheReused` is deliberately absent: it is
 * produced by `slotManager.acquire`, so feeding it back into the
 * routing decision would be circular. Do not add it.
 */
export interface StepComplexitySignals {
  /** `prompt.tokens.total` for the step about to run. */
  promptTokens: number;
  /** `prompt.tokens.stablePrefix` — the KV-stable head of the prompt. */
  stablePrefixTokens: number;
  /** 0-based index of this step inside the current turn. */
  stepIndex: number;
  /** `config.agent.maxSteps` — the turn's step budget. */
  maxSteps: number;
  /** `config.agent.conversationMaxTokens` — the conversation budget. */
  conversationMaxTokens: number;
  /**
   * Whether a one-shot notice is being rendered into this step's prompt
   * (loop detector fired, or a tool batch was trimmed). The model just
   * did something wrong, so the step deserves the stronger model.
   */
  hasTransientNotice: boolean;
}

/**
 * Weights sum to 100 so the score is directly comparable to the
 * operator's `cloudShare` dial without any rescaling.
 */
const WEIGHT_CONTEXT_PRESSURE = 40;
const WEIGHT_TURN_DEPTH = 25;
const WEIGHT_TRANSIENT_NOTICE = 20;
const WEIGHT_TAIL_GROWTH = 15;

/**
 * The tail is judged against half the conversation budget: a turn whose
 * accumulated tool output has eaten that much is already synthesis-shaped,
 * and waiting for the full budget would only escalate on the very last
 * step or two.
 */
const TAIL_BUDGET_FRACTION = 2;

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

function ratio(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return clamp01(numerator / denominator);
}

/**
 * Score one step's difficulty on a bounded 0-100 scale.
 *
 * Deliberately a *heuristic over cheap signals*, not a model call: it
 * runs before every inference in fusion mode, so it has to be free and
 * deterministic. The four terms, in weight order:
 *
 * 1. **Context pressure** (40) — how full the context is. This is the
 *    dominant term on purpose. It is also how a final synthesis step
 *    ends up on the cloud without the loop being able to know a step is
 *    final: by the time the model is ready to answer, it is carrying the
 *    whole turn's context.
 * 2. **Turn depth** (25) — later steps in a long turn are the ones that
 *    have to hold more state together.
 * 3. **Transient notice** (20) — a binary "the model just misbehaved"
 *    signal from the loop detector / batch trimmer.
 * 4. **Tail growth** (15) — how much of the prompt is accumulated tool
 *    output rather than the stable prefix, i.e. how much raw material
 *    this step has to reconcile.
 */
export function computeStepComplexity(
  signals: StepComplexitySignals,
): number {
  const tailTokens = Math.max(
    0,
    signals.promptTokens - signals.stablePrefixTokens,
  );
  const score =
    WEIGHT_CONTEXT_PRESSURE *
      ratio(signals.promptTokens, signals.conversationMaxTokens) +
    WEIGHT_TURN_DEPTH * ratio(signals.stepIndex, signals.maxSteps) +
    WEIGHT_TRANSIENT_NOTICE * (signals.hasTransientNotice ? 1 : 0) +
    WEIGHT_TAIL_GROWTH *
      ratio(
        tailTokens,
        signals.conversationMaxTokens / TAIL_BUDGET_FRACTION,
      );
  return Math.round(score);
}
