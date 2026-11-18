import type { TurnBudgetStop } from "./turn-budget.js";

/**
 * The abort reasons of a fusion worker stopped on purpose (ATO-1677).
 *
 * A worker request cut short rejects with its signal's reason as is (a
 * provider rethrows `signal.reason`), and the worker's loop reported a
 * plain `Error` reason to Sentry as a crash: from `stopForBudget` (a turn
 * cap) and from `Object.stop` (the person's `/fusion stop`). Every such
 * stop is the agent or the person doing what was asked, and the rows and
 * the tool result already say why. Error reporting drops these by
 * `name`, so the reporting layer takes no import from the tools layer.
 * Messages are the words the rows have always carried; only the class
 * is new, so nothing that classifies a worker's outcome changes.
 */

/** A turn's money or time cap was reached (`fusion.delegate`). */
export class FusionBudgetStopError extends Error {
  readonly kind: TurnBudgetStop["kind"];

  constructor(stop: TurnBudgetStop) {
    super(stop.message);
    this.name = FUSION_BUDGET_STOP_ERROR_NAME;
    this.kind = stop.kind;
  }
}

/** Why one worker was stopped (`worker-runner.ts`). */
export type FusionWorkerStopReason =
  /** The person stopped it (`/fusion stop`, the desktop's stop). */
  | "person"
  /** Its task was handed to the escalation model instead. */
  | "replaced"
  /** It wrote no file by half its budget and was handed back. */
  | "hand-back"
  /** The escalation model's run reached its time limit. */
  | "time-limit"
  /** The escalation model's run reached the escalation spend cap. */
  | "escalation-cap";

export class FusionWorkerStopError extends Error {
  constructor(
    readonly reason: FusionWorkerStopReason,
    message: string,
  ) {
    super(message);
    this.name = FUSION_WORKER_STOP_ERROR_NAME;
  }
}

/** The stable names error reporting matches on. */
export const FUSION_BUDGET_STOP_ERROR_NAME = "FusionBudgetStopError";
export const FUSION_WORKER_STOP_ERROR_NAME = "FusionWorkerStopError";
