import type { TurnBudgetStop } from "./turn-budget.js";

/**
 * Why a fusion fan-out was stopped by its own turn cap (ATO-1677).
 *
 * This is the abort reason `fusion.delegate` hands its budget signal, so
 * every worker request cut short by a cap rejects with it (a provider
 * rethrows `signal.reason` as is). A plain `Error` here was reported to
 * Sentry as a crash from `stopForBudget`; the cap is the operator's own
 * setting doing its job, and the rows and the tool result already say
 * which cap was reached. Error reporting drops it by `name`, so the
 * reporting layer takes no import from the tools layer.
 */
export class FusionBudgetStopError extends Error {
  readonly kind: TurnBudgetStop["kind"];

  constructor(stop: TurnBudgetStop) {
    super(stop.message);
    this.name = FUSION_BUDGET_STOP_ERROR_NAME;
    this.kind = stop.kind;
  }
}

/** The stable name error reporting matches on. */
export const FUSION_BUDGET_STOP_ERROR_NAME = "FusionBudgetStopError";
