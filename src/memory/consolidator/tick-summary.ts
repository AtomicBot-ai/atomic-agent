import type { StructuredLogger } from "../../tracing/structured-logger.js";

import type { CandidatePage } from "./candidate-window.js";

/** Per-tick summary returned by `ConsolidatorJob.runOnce`. */
export interface ConsolidatorTickResult {
  outcome: "ok" | "none" | "failed";
  /** ATO-2506. Notes read into this tick's candidate page. */
  candidates: number;
  /** ATO-2506. Which page was read; `null` when no page was read. */
  candidatePage: CandidatePage | null;
  clustersConsidered: number;
  lessonsCreated: number;
  lessonsAbstained: number;
  /** ATO-2506. Notes put off by the abstain backoff during this tick. */
  notesDeferred: number;
  failures: number;
  /**
   * Phase 6. Count of lessons demoted to `status='deprecated'`
   * during this tick.
   */
  lessonsDeprecatedByAge: number;
  lessonsDeprecatedByOverflow: number;
  /**
   * Phase 7a. Count of lessons demoted because their `vote_score`
   * went negative before they ever helped a turn. Always `0`
   * when `voting.enabled === false`.
   */
  lessonsDeprecatedByVote: number;
  /**
   * Phase 7a. Whether the per-tick `decayAllScores` pass ran on
   * this tick. `false` when voting is disabled or the runtime
   * could not construct a `VoteStore`.
   */
  voteDecayApplied: boolean;
  /**
   * Phase 7b. Count of procedures persisted in the same tick.
   * Always `<= lessonsCreated` because every procedure is paired
   * with a lesson (invariant 21). `0` when procedures are
   * disabled.
   */
  proceduresCreated: number;
  proceduresDeprecatedByCascade: number;
  proceduresDeprecatedByAge: number;
  proceduresDeprecatedByVote: number;
  proceduresDeprecatedByOverflow: number;
}

/** Phase 6: shared zero-summary so the new fields stay in sync. */
export function zeroSummary(): ConsolidatorTickResult {
  return {
    outcome: "none",
    candidates: 0,
    candidatePage: null,
    clustersConsidered: 0,
    lessonsCreated: 0,
    lessonsAbstained: 0,
    notesDeferred: 0,
    failures: 0,
    lessonsDeprecatedByAge: 0,
    lessonsDeprecatedByOverflow: 0,
    lessonsDeprecatedByVote: 0,
    voteDecayApplied: false,
    proceduresCreated: 0,
    proceduresDeprecatedByCascade: 0,
    proceduresDeprecatedByAge: 0,
    proceduresDeprecatedByVote: 0,
    proceduresDeprecatedByOverflow: 0,
  };
}

/**
 * ATO-2506. The one `consolidator.tick` line written per `runOnce`, the
 * no-op tick included, so the log shows that the job ran and what it did.
 * `skipped` is set when the tick did not run (the previous one still
 * held the lease set).
 */
export function logTickSummary(
  logger: StructuredLogger | undefined,
  result: ConsolidatorTickResult,
  skipped?: "already_running",
): void {
  const deprecated =
    result.lessonsDeprecatedByAge +
    result.lessonsDeprecatedByOverflow +
    result.lessonsDeprecatedByVote;
  const proceduresDeprecated =
    result.proceduresDeprecatedByCascade +
    result.proceduresDeprecatedByAge +
    result.proceduresDeprecatedByVote +
    result.proceduresDeprecatedByOverflow;
  logger?.info?.("consolidator.tick", {
    outcome: result.outcome,
    ...(skipped ? { skipped } : {}),
    candidates: result.candidates,
    page: result.candidatePage,
    clusters: result.clustersConsidered,
    lessonsCreated: result.lessonsCreated,
    abstained: result.lessonsAbstained,
    notesDeferred: result.notesDeferred,
    failures: result.failures,
    proceduresCreated: result.proceduresCreated,
    lessonsDeprecated: deprecated,
    ...(deprecated > 0
      ? {
          byAge: result.lessonsDeprecatedByAge,
          byOverflow: result.lessonsDeprecatedByOverflow,
          byVote: result.lessonsDeprecatedByVote,
        }
      : {}),
    proceduresDeprecated,
    ...(proceduresDeprecated > 0
      ? {
          proceduresByCascade: result.proceduresDeprecatedByCascade,
          proceduresByAge: result.proceduresDeprecatedByAge,
          proceduresByVote: result.proceduresDeprecatedByVote,
          proceduresByOverflow: result.proceduresDeprecatedByOverflow,
        }
      : {}),
    voteDecayApplied: result.voteDecayApplied,
  });
}
