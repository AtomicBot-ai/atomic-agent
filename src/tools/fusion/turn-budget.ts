/**
 * The per-turn caps of a fusion run (ATO-947): money and wall-clock time.
 *
 * A fusion turn used to have no ceiling but the 2-hour task limit: an
 * orchestrator that kept re-delegating to a cloud worker leg kept
 * spending. With `llm.runMode.fusion.turnBudgetUsd` / `turnTimeBudgetMs`
 * set, the turn stops starting new work once either is reached, stops
 * the workers still running, and the orchestrator is told to say so in
 * plain words. Both unset (the default): nothing here is consulted.
 *
 * Money is the orchestrator's priced spend so far this turn (the turn
 * usage meter) plus every worker's, each completion priced with its
 * prompt-cache discount (`estimateUsageCostUsd`). Unpriced tokens — a
 * local leg — count as $0: the cap is about the bill.
 *
 * One instance per runtime, reset per fusion turn by the turn's own
 * start (`clearFanoutTurnGrant`), so a cap is never carried from one
 * message into the next.
 */
export interface TurnBudgetLimits {
  usd?: number;
  timeMs?: number;
}

export interface TurnBudgetStop {
  kind: "usd" | "time";
  /** Plain words for the orchestrator to pass on. */
  message: string;
  spentUsd: number;
  elapsedMs: number;
}

interface TurnState {
  startedAt: number;
  workerUsd: number;
}

export class FusionTurnBudget {
  private readonly turns = new Map<string, TurnState>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A fusion turn starts on `sessionId`: its spend and clock start at zero. */
  begin(sessionId: string): void {
    this.turns.set(sessionId, { startedAt: this.now(), workerUsd: 0 });
  }

  private turn(sessionId: string): TurnState {
    let state = this.turns.get(sessionId);
    if (state === undefined) {
      // No turn start was seen (an embedder, a test): the clock starts
      // at the first fan-out instead.
      state = { startedAt: this.now(), workerUsd: 0 };
      this.turns.set(sessionId, state);
    }
    return state;
  }

  addWorkerSpend(sessionId: string, usd: number): void {
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.turn(sessionId).workerUsd += usd;
  }

  workerSpend(sessionId: string): number {
    return this.turns.get(sessionId)?.workerUsd ?? 0;
  }

  /** Milliseconds left before the time cap, `undefined` without one. */
  timeLeftMs(sessionId: string, limits: TurnBudgetLimits): number | undefined {
    if (limits.timeMs === undefined) return undefined;
    return limits.timeMs - (this.now() - this.turn(sessionId).startedAt);
  }

  /** Whether a cap is reached, and the words that say so. */
  check(
    sessionId: string,
    limits: TurnBudgetLimits,
    orchestratorUsd = 0,
  ): TurnBudgetStop | undefined {
    if (limits.usd === undefined && limits.timeMs === undefined) {
      return undefined;
    }
    const state = this.turn(sessionId);
    const elapsedMs = this.now() - state.startedAt;
    const spentUsd = orchestratorUsd + state.workerUsd;
    if (limits.usd !== undefined && spentUsd >= limits.usd) {
      return {
        kind: "usd",
        spentUsd,
        elapsedMs,
        message:
          `the spend cap for this turn is reached: ${formatUsd(spentUsd)} spent ` +
          `(${formatUsd(orchestratorUsd)} planning, ${formatUsd(state.workerUsd)} workers) ` +
          `of the ${formatUsd(limits.usd)} allowed by llm.runMode.fusion.turnBudgetUsd`,
      };
    }
    if (limits.timeMs !== undefined && elapsedMs >= limits.timeMs) {
      return {
        kind: "time",
        spentUsd,
        elapsedMs,
        message:
          `the time cap for this turn is reached: ${formatMinutes(elapsedMs)} ` +
          `of the ${formatMinutes(limits.timeMs)} allowed by llm.runMode.fusion.turnTimeBudgetMs`,
      };
    }
    return undefined;
  }
}

/** What the orchestrator is told to do once a cap stopped the work. */
export const TURN_BUDGET_INSTRUCTION =
  "No new delegations will run this turn. Do not do the remaining work yourself either: reply to the person now, in plain words — say that the cap stopped the work, what is done, what is not, and that they can raise the cap or say how to continue.";

export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function formatMinutes(ms: number): string {
  const minutes = ms / 60_000;
  return minutes < 1
    ? `${Math.max(0, Math.round(ms / 1000))} s`
    : `${minutes.toFixed(minutes < 10 ? 1 : 0)} min`;
}
