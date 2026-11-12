import type { BreakerTrip } from "./failure-breaker.js";

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
  /** The orchestrator's meter reading when the turn began; spend is the delta. */
  orchestratorBaseUsd: number;
  /** Task id → how many times it was run this turn (ATO-941's replans). */
  attempts: Map<string, number>;
  /** Delegations started this turn, and the tasks they carried (ATO-1406). */
  rounds: number;
  tasks: number;
  /** Every failure breaker that tripped this turn (ATO-1406). */
  trips: BreakerTrip[];
}

/**
 * The turn's count caps (ATO-1406): delegations ("rounds") and tasks.
 * Counted, not priced, because a subscription leg has no bill to read —
 * its limit is requests. `undefined`: that cap is off.
 */
export interface TurnCountLimits {
  rounds?: number;
  tasks?: number;
}

export interface TurnCountStop {
  kind: "rounds" | "tasks";
  message: string;
}

export class FusionTurnBudget {
  private readonly turns = new Map<string, TurnState>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * A fusion turn starts on `sessionId`: its spend and clock start at
   * zero. `orchestratorBaseUsd` is what the orchestrator's meter already
   * reads (non-zero when the bucket outlives a turn, as on the sidecar).
   */
  begin(sessionId: string, orchestratorBaseUsd = 0): void {
    this.turns.set(sessionId, {
      startedAt: this.now(),
      workerUsd: 0,
      orchestratorBaseUsd,
      attempts: new Map(),
      rounds: 0,
      tasks: 0,
      trips: [],
    });
  }

  private turn(sessionId: string): TurnState {
    let state = this.turns.get(sessionId);
    if (state === undefined) {
      // No turn start was seen (an embedder, a test): the clock starts
      // at the first fan-out instead.
      state = {
        startedAt: this.now(),
        workerUsd: 0,
        orchestratorBaseUsd: 0,
        attempts: new Map(),
        rounds: 0,
        tasks: 0,
        trips: [],
      };
      this.turns.set(sessionId, state);
    }
    return state;
  }

  addWorkerSpend(sessionId: string, usd: number): void {
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.turn(sessionId).workerUsd += usd;
  }

  /** Count one run of `taskId` this turn; returns the count so far. */
  noteAttempt(sessionId: string, taskId: string): number {
    const attempts = this.turn(sessionId).attempts;
    const count = (attempts.get(taskId) ?? 0) + 1;
    attempts.set(taskId, count);
    return count;
  }

  attempts(sessionId: string, taskId: string): number {
    return this.turns.get(sessionId)?.attempts.get(taskId) ?? 0;
  }

  /** What this turn's delegations so far ran: rounds and tasks. */
  counts(sessionId: string): { rounds: number; tasks: number } {
    const state = this.turns.get(sessionId);
    return { rounds: state?.rounds ?? 0, tasks: state?.tasks ?? 0 };
  }

  /**
   * Whether a new delegation of `taskCount` tasks would pass a count
   * cap; the words that say so when it would. Checked before it starts.
   */
  checkCounts(
    sessionId: string,
    limits: TurnCountLimits,
    taskCount: number,
  ): TurnCountStop | undefined {
    const { rounds, tasks } = this.counts(sessionId);
    if (limits.rounds !== undefined && rounds + 1 > limits.rounds) {
      return {
        kind: "rounds",
        message:
          `this turn already ran ${rounds} delegation${rounds === 1 ? "" : "s"}, ` +
          `the most llm.runMode.fusion.maxRoundsPerTurn allows (${limits.rounds})`,
      };
    }
    if (limits.tasks !== undefined && tasks + taskCount > limits.tasks) {
      return {
        kind: "tasks",
        message:
          `${taskCount} more task${taskCount === 1 ? "" : "s"} would take this turn to ${tasks + taskCount}, ` +
          `over the ${limits.tasks} llm.runMode.fusion.maxTasksPerTurn allows (${tasks} already ran)`,
      };
    }
    return undefined;
  }

  /** Count a delegation that is starting, with its tasks. */
  noteRound(sessionId: string, taskCount: number): void {
    const state = this.turn(sessionId);
    state.rounds += 1;
    state.tasks += Math.max(0, taskCount);
  }

  /** Remember a failure breaker that tripped this turn. */
  noteTrip(sessionId: string, trip: BreakerTrip): void {
    this.turn(sessionId).trips.push(trip);
  }

  trips(sessionId: string): readonly BreakerTrip[] {
    return this.turns.get(sessionId)?.trips ?? [];
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
    orchestratorMeterUsd = 0,
  ): TurnBudgetStop | undefined {
    if (limits.usd === undefined && limits.timeMs === undefined) {
      return undefined;
    }
    const state = this.turn(sessionId);
    const orchestratorUsd = Math.max(
      0,
      orchestratorMeterUsd - state.orchestratorBaseUsd,
    );
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

/** What the orchestrator is told when a count cap refuses a delegation. */
export const TURN_COUNT_INSTRUCTION =
  "Do not re-send the work and do not do it yourself. Reply to the person now, in plain words: say how many rounds and tasks already ran, what is done and what is not, and that they can say how to continue (or raise the cap).";

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
