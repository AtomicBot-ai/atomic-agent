
export type LoopCheckLevel = "ok" | "warn" | "critical";

/**
 * Why a wandering loop must be stopped, and the spread the rule that
 * fired measured — the number the veto and the forced reply quote, so
 * each message describes the set of calls it is actually about.
 */
export interface WanderingStop {
  /** True when the prospective call rides the breaker path. */
  escalated: boolean;
  /** Spread measured by the rule that fired; `0` for a non-probe tool. */
  spread: number;
  /**
   * `"run"` — distinct probes since the turn last made progress outside
   * this tool's family. `"ceiling"` — the absolute window cap
   * (`WANDERING_CEILING_SHARE` of `loopHistorySize`). `null` when nothing
   * fired.
   */
  rule: "run" | "ceiling" | null;
}

/**
 * Verdict of `ToolLoopTracker.recordOutcome`: has this exact result
 * (tool, status, normalised summary head) come back before this turn?
 */
export interface OutcomeRepeatCheck {
  /** True once the fingerprint has been seen `OUTCOME_REPEAT_WARNING_THRESHOLD` times. */
  repeat: boolean;
  /** Times this fingerprint has been recorded, this one included. */
  count: number;
  /** The fingerprint itself — the warn-bucket key. */
  fingerprint: string;
}

/**
 * Verdict of `ToolLoopTracker.checkReadRepeat`: did this read show the
 * model any line it had not already seen this turn?
 */
export interface ReadRepeatCheck {
  /** True when the read returned no line the turn had not already seen. */
  repeat: boolean;
  /** Consecutive no-progress reads of this file version; ≥1 when `repeat`. */
  count: number;
  /** Compact list of lines already read, e.g. `"1-40, 88-120"`. */
  covered: string;
  /**
   * Fingerprint of the version this file was last read at, when it was
   * read before. Equal to the observation's own hash for a `repeat` —
   * that equality IS the "unchanged content" half of the verdict, so the
   * event carries both sides and a trace reader can check it.
   */
  previousFingerprint?: string;
}

/**
 * Verdict of `ToolLoopTracker.checkTestRepeat`: is this recognized test
 * command an equivalent re-run against an unchanged workspace?
 */
export interface TestRepeatCheck {
  /** True when the key repeats against an identical fingerprint. */
  repeat: boolean;
  /** 1 for a fresh/changed-workspace run; N for the Nth equivalent run. */
  count: number;
  /** Compressed summary of the previous equivalent run, when recorded. */
  previousSummary?: string;
}

export interface ToolLoopTrackerOptions {
  /** Args-only repeat count that fires a `warn`. Min 2. Default 3. */
  warningThreshold?: number;
  /** No-progress streak (args+result) that fires a `critical` veto. Default 5. */
  criticalThreshold?: number;
  /** Consecutive vetoes of one signature that trip the breaker. Default 3. */
  breakerVetoStreak?: number;
  /** Sliding window size for the history ring. Default 30. */
  historySize?: number;
  /** Warn de-dup bucket size. Default `LOOP_WARNING_BUCKET_SIZE`. */
  warningBucketSize?: number;
  /**
   * Distinct-args spread on a wandering-prone tool, counted since the
   * turn last made progress with another tool, that fires a `wandering`
   * warn (actionable redirect). Min 2. Default 6.
   */
  wanderingThreshold?: number;
  /**
   * The same run spread at which a wandering loop escalates to a forced
   * graceful reply (the redirect did not land). Default 12. The window
   * spread escalates on its own at
   * `WANDERING_CEILING_FACTOR x` this value, whatever else the turn did.
   */
  wanderingEscalation?: number;
}

export interface LoopCheckVerdict {
  level: LoopCheckLevel;
  /**
   * Repeat count (warn), no-progress streak length (critical), or
   * distinct-args run spread (wandering).
   */
  count: number;
  detector:
    | "generic_repeat"
    | "no_progress"
    | "wandering"
    | "test_repeat"
    | "read_repeat"
    | "outcome_repeat";
  /** Stable key for warn de-duplication and breaker signalling. */
  warningKey: string;
  tool: string;
  argsHash: string;
}
