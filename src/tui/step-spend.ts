import { EMPTY_SESSION_USAGE, type SessionUsageState } from "../session/usage-meter.js";

/**
 * What one step of the running turn spent (ATO-34, `/why`). Built in the
 * TUI from the session-scoped `usage_updated` events the runtime already
 * sends after every model call: the difference between two readings is
 * that call, and it lands on the step that was running when it arrived.
 *
 * No price is looked up or guessed here. The runtime's own pricing
 * (`priceCompletion` in `session/usage-meter.ts`: the service's bill,
 * then the operator's or the catalog's price) already decided whether a
 * call is priced, unpriced, local or plan-billed; this only keeps that
 * split per step.
 */
export interface StepSpend {
  /** Sum of the step's priced calls, USD. */
  usd: number;
  pricedCalls: number;
  /** Cloud calls with no known price: the step's cost is then unknown. */
  unpricedCalls: number;
  /** Calls served by a local model: never billed. */
  localCalls: number;
  /** Calls billed by a subscription plan, not per token. */
  planCalls: number;
}

export type StepSpendByStep = Readonly<Record<number, StepSpend>>;

const EMPTY_STEP_SPEND: StepSpend = {
  usd: 0,
  pricedCalls: 0,
  unpricedCalls: 0,
  localCalls: 0,
  planCalls: 0,
};

/**
 * Fold one `usage_updated` reading into the step that was running.
 * `prev` is the session usage the TUI held before it (`null`: nothing
 * yet, read as empty). A reading that changed no call count (a fresh
 * rate-limit figure) or that went backwards (the session's usage was
 * replaced, e.g. on a switch) is not a call and changes nothing.
 */
export function addStepSpend(
  byStep: StepSpendByStep,
  prev: SessionUsageState | null,
  next: SessionUsageState,
  stepIndex: number,
): StepSpendByStep {
  const before = prev ?? EMPTY_SESSION_USAGE;
  const delta: StepSpend = {
    usd: next.costUsd - before.costUsd,
    pricedCalls: next.pricedCalls - before.pricedCalls,
    unpricedCalls: next.unpricedCalls - before.unpricedCalls,
    localCalls: next.localCalls - before.localCalls,
    planCalls: next.planCalls - before.planCalls,
  };
  const counts = [
    delta.pricedCalls,
    delta.unpricedCalls,
    delta.localCalls,
    delta.planCalls,
  ];
  if (counts.some((n) => n < 0) || delta.usd < -1e-12) return byStep;
  if (counts.every((n) => n === 0)) return byStep;
  const was = byStep[stepIndex] ?? EMPTY_STEP_SPEND;
  return {
    ...byStep,
    [stepIndex]: {
      usd: was.usd + Math.max(0, delta.usd),
      pricedCalls: was.pricedCalls + delta.pricedCalls,
      unpricedCalls: was.unpricedCalls + delta.unpricedCalls,
      localCalls: was.localCalls + delta.localCalls,
      planCalls: was.planCalls + delta.planCalls,
    },
  };
}

/**
 * The step's dollar cost when it is known: at least one priced call and
 * no unpriced one. A step served only by a local model or a plan, or
 * one with a cloud call nobody priced, has no figure (`null`), so `/why`
 * shows nothing rather than `$0.00` or a guess. Local calls beside
 * priced ones add nothing, so the priced sum is the step's real cost.
 */
export function knownStepCostUsd(spend: StepSpend | undefined): number | null {
  if (!spend) return null;
  if (spend.pricedCalls <= 0 || spend.unpricedCalls > 0) return null;
  return spend.usd;
}
