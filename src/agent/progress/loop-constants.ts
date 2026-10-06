
/**
 * Synthetic tool name used for batched-step diagnostics. A multi-call
 * inference is hashed as one composite entry under this label so two
 * identical batches in a row are detected, but a permuted batch (same
 * calls, different order) is not — the model may legitimately reorder a
 * set after re-thinking.
 */
export const BATCH_LOOP_LABEL = "<batch>";

/**
 * `details.deniedReason` value stamped on a synthetic tool result when a
 * call is vetoed as a no-progress loop. Used by `isLoopVetoResult` to
 * exclude the vetoed entry from the no-progress streak so the streak
 * plateaus at `criticalThreshold` instead of climbing forever.
 */
export const LOOP_VETO_DENIED_REASON = "tool-loop";

/**
 * Bucket size for warn de-duplication. A warning for a given
 * `warningKey` is emitted at most once per bucket of N matching repeats
 * so the `### notice` is not re-injected on every subsequent step.
 */
export const LOOP_WARNING_BUCKET_SIZE = 10;

/**
 * Share of the history window that must be distinct probes on ONE tool
 * before the window spread escalates on its own, whatever else the turn
 * achieved between them (issue #458).
 *
 * The run spread (`ProbeRuns`) is what normally decides, and other work
 * settles it — so a model that opens a page every couple of searches
 * never reaches that cap. That is the behaviour the redirect asks for,
 * but it must not become unbounded: the GAIA traces this detector was
 * built for show ~35 re-formulated queries with barely a fetch between
 * them. At 0.6 the ceiling is 18 of the default 30-call window: three of
 * every five recent calls are distinct probes on one tool, which is
 * churn on any reading, while the reported research fan-outs (12 probes
 * among 28 and 48 calls) stay well below it.
 *
 * A SHARE, not a multiple of `wanderingEscalation`, for two reasons. It
 * is reachable at every configuration — a multiple is not: at
 * `escalation >= 15` a doubled ceiling needs a window of pure probes, in
 * which case the run rule has already fired, leaving the ceiling dead.
 * And it keeps `loopHistorySize` the only knob that moves the window, so
 * turning the wandering knob cannot widen the ring the unrelated
 * repeat / no-progress detectors walk.
 */
export const WANDERING_CEILING_SHARE = 0.6;

/**
 * Equivalent-run count at which the test-repeat detector (issue #118)
 * warns: the 2nd recognized test command against an unchanged workspace
 * fingerprint is already conclusive (the suite cannot produce new
 * evidence), unlike the generic byte-repeat where a rerun may be an
 * intentional retry. Warn-only — never routed into the veto/breaker.
 */
export const TEST_REPEAT_WARNING_THRESHOLD = 2;

/**
 * No-progress read count at which the read-coverage detector (issue #114)
 * warns. A single redundant re-read is ordinary behaviour — the model
 * re-opens a file to re-orient itself, or widens a window it half
 * remembers — so the floor is the SECOND consecutive read of one
 * unchanged file that returned nothing new. Warn-only, like the
 * test-repeat detector: nothing is ever vetoed on this signal.
 */
export const READ_REPEAT_WARNING_THRESHOLD = 2;

/**
 * Outcome-fingerprint count at which the outcome-repeat detector warns:
 * the third time a turn gets the same result back — the same failing
 * `node --check` output, the same directory listing — whatever the
 * arguments were. The argument-keyed detectors above cannot see it: run
 * 02 ran one failing check chain five times with one warning, and run 04
 * spent six steps re-globbing and re-grepping with slightly different
 * arguments and identical answers. Warn-only, never a veto: polling a
 * build or re-running a test after each fix is legitimate work, and the
 * counter resets the moment a write lands (see `isSuccessfulWrite`).
 */
export const OUTCOME_REPEAT_WARNING_THRESHOLD = 3;
