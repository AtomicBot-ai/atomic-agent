import { BATCH_LOOP_LABEL, LOOP_WARNING_BUCKET_SIZE, WANDERING_CEILING_SHARE, OUTCOME_REPEAT_WARNING_THRESHOLD } from "./progress/loop-constants.js";
export { BATCH_LOOP_LABEL, LOOP_VETO_DENIED_REASON, LOOP_WARNING_BUCKET_SIZE, WANDERING_CEILING_SHARE, TEST_REPEAT_WARNING_THRESHOLD, READ_REPEAT_WARNING_THRESHOLD, OUTCOME_REPEAT_WARNING_THRESHOLD } from "./progress/loop-constants.js";
import type { WanderingStop, OutcomeRepeatCheck, ReadRepeatCheck, TestRepeatCheck, ToolLoopTrackerOptions, LoopCheckVerdict } from "./progress/loop-contract.js";
export type { LoopCheckLevel, WanderingStop, OutcomeRepeatCheck, ReadRepeatCheck, TestRepeatCheck, ToolLoopTrackerOptions, LoopCheckVerdict } from "./progress/loop-contract.js";
import { isSuccessfulWrite, fingerprintToolOutcome, isLoopVetoResult, hashToolCall, hashToolOutcome, hashBatchCompositeArgs, hashBatchCompositeResults, sameReadVersion } from "./progress/loop-fingerprints.js";
export { isSuccessfulWrite, fingerprintToolOutcome, isLoopVetoResult, hashToolCall, hashToolOutcome } from "./progress/loop-fingerprints.js";
export { formatRepeatNotice, formatVetoInstruction, formatTestRepeatNotice, formatOutcomeRepeatNotice, formatReadRepeatNotice, formatWanderingRedirect, formatForcedLoopReply, extractLoopTarget } from "./progress/loop-notices.js";

import type { CompressedToolResult } from "../compressor/result-compressor.js";
import {
  describeCoverage,
  mergeRange,
  newlyCoveredCount,
  type LineRange,
  type ReadObservation,
} from "./read-coverage.js";
import { ProbeRuns, probeFamily } from "./wandering-spread.js";

/**
 * Cap on distinct outcome fingerprints tracked in one turn; the oldest
 * is evicted first. A turn that produces hundreds of distinct results is
 * not looping on any of them, so eviction can only cost a detection.
 */
const MAX_TRACKED_OUTCOMES = 200;

/**
 * Cap on files tracked for read coverage in one turn. A wide scan (a
 * grep-driven sweep over hundreds of files) must not grow the tracker
 * without bound, and the interesting file is always a recently read one,
 * so the least-recently-read entry is evicted first. Eviction can only
 * cost a detection, never cause a false one.
 */
const MAX_TRACKED_READ_FILES = 200;

/**
 * Tools whose repeated invocation with ever-changing arguments is a
 * "wandering" loop (probing endless distinct URLs / queries / pages
 * without converging). Bulk reads over distinct files (`os.fs.read`) are
 * deliberately excluded — scanning many files is legitimate work, not a
 * loop.
 *
 * `os.web.search` is included: GAIA traces show small models burn an entire
 * step budget re-formulating ~35 distinct search queries (different quotes /
 * keywords / versions) while barely fetching the pages they already found.
 * Each query is unique, so the args-only and no-progress streaks never fire —
 * only the distinct-spread wandering detector can bound that token burn.
 */
export function isWanderingProneTool(tool: string): boolean {
  return probeFamily(tool) !== null;
}

interface HistoryEntry {
  tool: string;
  argsHash: string;
  /** Set by `recordOutcome`. `undefined` while pending or when vetoed. */
  resultHash?: string;
  /** True when the outcome was a loop veto (excluded from the streak). */
  vetoed?: boolean;
}

/**
 * OpenClaw-style per-turn tool loop tracker.
 *
 * Two-phase history: `check()` runs FIRST against history-so-far, then
 * `recordCall()` pushes the args entry, then after execution
 * `recordOutcome()` patches the semantic `resultHash`. The current call
 * is therefore not in history when it is checked.
 *
 * Two distinct counters:
 *  - `getRepeatCount` (args-only, interleaving-tolerant) drives `warn`.
 *  - `getNoProgressStreak` (args+result identical, interleaving-tolerant,
 *    result-aware) drives `critical` → veto.
 *
 * A veto result is excluded from the streak (its entry carries no
 * `resultHash`), so once vetoing starts the streak plateaus at
 * `criticalThreshold`. Termination is driven by a separate
 * consecutive-veto counter (`isBreakerTripped`), not by the streak.
 */
export class ToolLoopTracker {
  private readonly warningThreshold: number;
  private readonly criticalThreshold: number;
  private readonly breakerVetoStreak: number;
  private readonly historySize: number;
  private readonly warningBucketSize: number;
  private readonly wanderingThreshold: number;
  private readonly wanderingEscalation: number;
  /** Window-spread stop; see `WANDERING_CEILING_SHARE`. */
  private readonly wanderingCeiling: number;
  /** Window-spread warn, the rung below `wanderingCeiling`. */
  private readonly wanderingWindowWarning: number;
  private readonly history: HistoryEntry[] = [];
  private readonly warningBuckets = new Map<string, number>();
  private consecutiveVetoSignature: string | null = null;
  private consecutiveVetoCount = 0;
  /**
   * Test-repeat detector state (issue #118): semantic test-command key →
   * the workspace fingerprint captured before its latest run, how many
   * equivalent runs in a row that fingerprint has seen, and the summary
   * of the previous run's result (patched in by `recordOutcome`).
   */
  private readonly testRuns = new Map<
    string,
    { fingerprint: string; count: number; lastSummary?: string }
  >();
  /**
   * Call-signature → semantic test key for runs dispatched but not yet
   * completed, so `recordOutcome` can attach the result summary to the
   * right `testRuns` entry without re-classifying the command.
   */
  private readonly pendingTestKeys = new Map<string, string>();
  /**
   * Read-coverage detector state (issue #114): canonical file path → the
   * content fingerprint and rendering that path was last read at, the
   * merged set of lines read at THAT version, and how many reads in a
   * row have returned nothing outside it. Insertion order doubles as a
   * least-recently-read order for eviction (see `MAX_TRACKED_READ_FILES`).
   */
  private readonly readCoverage = new Map<
    string,
    {
      contentHash: string;
      numbered: boolean;
      covered: LineRange[];
      noProgress: number;
    }
  >();
  /**
   * Outcome-repeat detector state: outcome fingerprint → how many times
   * this turn has received it since the last successful write. Cleared
   * whole by a successful `os.fs.write` / `edit` / `patch`: a write is the
   * progress every repeated result was waiting for, so the counts before
   * it are about a workspace that no longer exists. Insertion order is
   * the eviction order (see `MAX_TRACKED_OUTCOMES`).
   */
  private readonly outcomeCounts = new Map<string, number>();
  /**
   * Wandering runs (issue #458): distinct probe signatures per
   * wandering-prone tool since the turn last completed a successful call
   * to a different tool. This is the spread the detector acts on; the
   * window spread is kept only for the absolute ceiling.
   */
  private readonly probeRuns = new ProbeRuns();

  constructor(options: ToolLoopTrackerOptions = {}) {
    this.warningThreshold = Math.max(2, options.warningThreshold ?? 3);
    this.criticalThreshold = Math.max(
      this.warningThreshold,
      options.criticalThreshold ?? 5,
    );
    this.breakerVetoStreak = Math.max(1, options.breakerVetoStreak ?? 3);
    this.wanderingThreshold = Math.max(2, options.wanderingThreshold ?? 6);
    this.wanderingEscalation = Math.max(
      this.wanderingThreshold,
      options.wanderingEscalation ?? 12,
    );
    this.historySize = Math.max(
      this.criticalThreshold,
      this.wanderingEscalation,
      options.historySize ?? 30,
    );
    // The window ladder, derived from the window so it is always
    // reachable. Its warn sits at the same fraction of its stop as the
    // run ladder's does, so neither ladder can hard-stop a turn that was
    // never warned (min 2, and the warn always below the stop).
    this.wanderingCeiling = Math.max(
      2,
      Math.ceil(this.historySize * WANDERING_CEILING_SHARE),
    );
    this.wanderingWindowWarning = Math.min(
      this.wanderingCeiling - 1,
      Math.max(
        2,
        Math.round(
          (this.wanderingCeiling * this.wanderingThreshold) /
            this.wanderingEscalation,
        ),
      ),
    );
    this.warningBucketSize = Math.max(
      1,
      options.warningBucketSize ?? LOOP_WARNING_BUCKET_SIZE,
    );
  }

  /**
   * Classify a prospective call against history-so-far. Call BEFORE
   * `recordCall` — the current call must not be in history yet.
   */
  check(tool: string, args: unknown): LoopCheckVerdict {
    const argsHash = hashToolCall(tool, args);
    const noProgress = getNoProgressStreak(this.history, tool, argsHash);
    if (noProgress.count >= this.criticalThreshold) {
      return {
        level: "critical",
        count: noProgress.count,
        detector: "no_progress",
        warningKey: `critical:${tool}:${argsHash}:${noProgress.latestResultHash ?? "none"}`,
        tool,
        argsHash,
      };
    }
    if (isWanderingProneTool(tool)) {
      // A spread is a property of a whole run or window, so it stays above
      // the threshold after the model stops varying its argument and settles
      // on repeating one. Classifying THIS call as wandering would then tell
      // it "N different attempts" about a call that is a verbatim repeat --
      // the same kind of false statement the wandering wording exists to
      // avoid. A repeat falls through to the repeat detector, which
      // describes it accurately.
      const repeatsEarlierCall =
        getRepeatCount(this.history, tool, argsHash) > 0;
      const warn = this.wanderingWarning(tool, argsHash);
      if (warn !== null && !repeatsEarlierCall) {
        return {
          level: "warn",
          count: warn,
          detector: "wandering",
          // Per-tool key (not per-args) so the redirect notice is emitted
          // once per wandering episode, not once per distinct URL.
          warningKey: `wandering:${tool}`,
          tool,
          argsHash,
        };
      }
    }
    const repeatCount = getRepeatCount(this.history, tool, argsHash);
    if (repeatCount >= this.warningThreshold) {
      return {
        level: "warn",
        count: repeatCount,
        detector: "generic_repeat",
        warningKey: `warn:${tool}:${argsHash}`,
        tool,
        argsHash,
      };
    }
    return {
      level: "ok",
      count: 0,
      detector: "generic_repeat",
      warningKey: `ok:${tool}:${argsHash}`,
      tool,
      argsHash,
    };
  }

  /**
   * Whether a prospective `(tool, args)` must be stopped as a wandering
   * loop, and the spread the rule that fired measured. Pure — call BEFORE
   * `recordCall` (the prospective call is folded into both spreads). The
   * agent loop maps an `escalated` onto the breaker path (forced graceful
   * reply).
   *
   * Two rules, because they answer different questions (issue #458). The
   * RUN spread asks "is this probing going anywhere?" — it is settled by
   * any other tool succeeding, so 12 searches with a script run and a
   * fetch between them never reach it. The window CEILING asks "how much
   * of this turn is probing?" regardless of what else landed, so churn
   * that hides behind an occasional fetch is still bounded.
   */
  wanderingStop(tool: string, args: unknown): WanderingStop {
    if (!isWanderingProneTool(tool)) {
      return { escalated: false, spread: 0, rule: null };
    }
    const argsHash = hashToolCall(tool, args);
    const runSpread = this.probeRuns.spread(tool, argsHash);
    if (runSpread >= this.wanderingEscalation) {
      return { escalated: true, spread: runSpread, rule: "run" };
    }
    const windowSpread = this.effectiveSpread(tool, argsHash);
    if (windowSpread >= this.wanderingCeiling) {
      return { escalated: true, spread: windowSpread, rule: "ceiling" };
    }
    return { escalated: false, spread: runSpread, rule: null };
  }

  /**
   * The spread to warn about, or `null` when neither ladder has reached
   * its warn rung. Both ladders warn, because either can end the turn:
   * a stop the model was never nudged about is the redirect notice — and
   * the `os.web.search` wording below it — being dead code in exactly the
   * shapes that need it.
   */
  private wanderingWarning(tool: string, argsHash: string): number | null {
    const runSpread = this.probeRuns.spread(tool, argsHash);
    if (runSpread >= this.wanderingThreshold) return runSpread;
    const windowSpread = this.effectiveSpread(tool, argsHash);
    return windowSpread >= this.wanderingWindowWarning ? windowSpread : null;
  }

  /**
   * Whether the wandering spread on `(tool, args)` has crossed a cap.
   * Thin wrapper over `wanderingStop` for callers that only need the
   * verdict.
   */
  isWanderingEscalated(tool: string, args: unknown): boolean {
    return this.wanderingStop(tool, args).escalated;
  }

  /**
   * The wandering spread for a prospective `(tool, args)` — the run
   * spread the detector acts on, or the window spread when the ceiling is
   * what stopped the call. `0` for a tool that is not wandering-prone.
   * Pure; call BEFORE `recordCall`.
   */
  wanderingSpread(tool: string, args: unknown): number {
    return this.wanderingStop(tool, args).spread;
  }

  /**
   * Distinct count of completed (non-veto) `argsHash`es seen for `tool` in
   * the window, plus one when the prospective call introduces a new
   * signature (the current call is not yet in history at `check` time).
   * Feeds the absolute ceiling only — see `wanderingStop`.
   */
  private effectiveSpread(tool: string, currentArgsHash: string): number {
    const seen = new Set<string>();
    for (const record of this.history) {
      if (record.tool !== tool) continue;
      if (typeof record.resultHash !== "string" || !record.resultHash) continue;
      seen.add(record.argsHash);
    }
    return seen.has(currentArgsHash) ? seen.size : seen.size + 1;
  }

  /** Push a pending history entry. Call at dispatch, AFTER `check`. */
  recordCall(tool: string, args: unknown): void {
    const argsHash = hashToolCall(tool, args);
    this.history.push({ tool, argsHash });
    this.trimHistory();
  }

  /**
   * Patch the latest pending entry for `(tool, args)` with the semantic
   * result hash. A loop-veto result leaves `resultHash` undefined (so the
   * entry is skipped by the streak walk) and bumps the consecutive-veto
   * counter. A real (non-veto) outcome resets the veto counter when its
   * signature differs from the one currently being vetoed.
   *
   * Also folds the outcome into the outcome-repeat detector and returns
   * its verdict: the same result coming back for the Nth time, whatever
   * the arguments. A successful write resets that detector instead of
   * being counted — it is the progress the repeats were missing.
   */
  recordOutcome(
    tool: string,
    args: unknown,
    result: CompressedToolResult,
  ): OutcomeRepeatCheck {
    this.noteTestOutcome(tool, args, result);
    if (isLoopVetoResult(result)) {
      this.patchLatestPending(tool, args, { vetoed: true });
      this.noteVeto(tool, args);
      return { repeat: false, count: 0, fingerprint: "" };
    }
    const resultHash = hashToolOutcome(tool, args, result);
    if (resultHash === undefined) {
      return { repeat: false, count: 0, fingerprint: "" };
    }
    this.patchLatestPending(tool, args, { resultHash });
    // Wandering runs (issue #458). A call that landed either settles the
    // other tools' runs (it is the progress they were missing) or joins
    // its own. A vetoed call returned above: it never ran.
    this.probeRuns.record(tool, hashToolCall(tool, args), result.status === "ok");
    if (this.consecutiveVetoSignature !== null) {
      const sig = hashToolCall(tool, args);
      if (sig !== this.consecutiveVetoSignature) {
        this.consecutiveVetoSignature = null;
        this.consecutiveVetoCount = 0;
      }
    }
    return this.noteOutcomeFingerprint(tool, result);
  }

  /**
   * The outcome-repeat half of `recordOutcome`. A successful write clears
   * every count and is not counted itself; anything else bumps its
   * fingerprint's count and reports whether the threshold is met.
   */
  private noteOutcomeFingerprint(
    tool: string,
    result: CompressedToolResult,
  ): OutcomeRepeatCheck {
    if (isSuccessfulWrite(tool, result)) {
      this.outcomeCounts.clear();
      return { repeat: false, count: 0, fingerprint: "" };
    }
    const fingerprint = fingerprintToolOutcome(tool, result);
    const count = (this.outcomeCounts.get(fingerprint) ?? 0) + 1;
    // Re-insert so the map's order stays least-recently-seen first.
    this.outcomeCounts.delete(fingerprint);
    this.outcomeCounts.set(fingerprint, count);
    if (this.outcomeCounts.size > MAX_TRACKED_OUTCOMES) {
      const oldest = this.outcomeCounts.keys().next();
      if (!oldest.done) this.outcomeCounts.delete(oldest.value);
    }
    return {
      repeat: count >= OUTCOME_REPEAT_WARNING_THRESHOLD,
      count,
      fingerprint,
    };
  }

  /**
   * Classify a recognized test command's prospective run against the
   * stored `(key → fingerprint)` state (issue #118). Pure map lookup —
   * the fingerprint walk happens at the call site, and only for
   * recognized test commands. Call BEFORE `recordTestRun`.
   */
  checkTestRepeat(key: string, fingerprint: string): TestRepeatCheck {
    const prev = this.testRuns.get(key);
    if (prev === undefined || prev.fingerprint !== fingerprint) {
      return { repeat: false, count: 1 };
    }
    return {
      repeat: true,
      count: prev.count + 1,
      ...(prev.lastSummary !== undefined
        ? { previousSummary: prev.lastSummary }
        : {}),
    };
  }

  /**
   * Record a recognized test command being dispatched: store the
   * fingerprint captured before this run and remember the call
   * signature so `recordOutcome` can patch in the result summary. A
   * changed fingerprint resets the equivalent-run count AND drops the
   * stored summary — a later warning must cite a result produced
   * against the current workspace state, never a pre-change one.
   */
  recordTestRun(
    key: string,
    fingerprint: string,
    tool: string,
    args: unknown,
  ): void {
    const prev = this.testRuns.get(key);
    const unchanged = prev !== undefined && prev.fingerprint === fingerprint;
    this.testRuns.set(key, {
      fingerprint,
      count: unchanged ? prev.count + 1 : 1,
      ...(unchanged && prev.lastSummary !== undefined
        ? { lastSummary: prev.lastSummary }
        : {}),
    });
    this.pendingTestKeys.set(hashToolCall(tool, args), key);
  }

  /**
   * Classify a completed read against the coverage recorded for its file
   * (issue #114). Pure — call BEFORE `recordRead`.
   *
   * Unlike the other detectors this one is post-hoc by necessity: which
   * lines a read returns, and which version of the file it saw, are facts
   * about the RESULT. There is nothing to gate at dispatch time, which is
   * also why the signal is warn-only — the read has already happened, so
   * blocking it would cost the model information without saving anything.
   *
   * No progress means: the file's content is byte-identical to what it
   * was when this turn last read it, it was rendered the same way, and
   * every line this read returned was already returned earlier in the
   * turn. A read that returned no lines at all (an offset past the end)
   * also counts — it cannot have shown anything new — but only once the
   * file has been seen at this version, so the first such read is never
   * flagged.
   *
   * The rendering half of "version" is what keeps a plain read followed
   * by a `lineNumbers: true` re-read of the same lines — the normal
   * preparation for a precise edit — off this detector: that re-read
   * does return text the model did not have.
   */
  checkReadRepeat(observation: ReadObservation): ReadRepeatCheck {
    const prev = this.readCoverage.get(observation.path);
    if (prev === undefined) return { repeat: false, count: 0, covered: "" };
    const previousFingerprint = prev.contentHash;
    if (!sameReadVersion(prev, observation)) {
      return { repeat: false, count: 0, covered: "", previousFingerprint };
    }
    const fresh =
      observation.span === null
        ? 0
        : newlyCoveredCount(prev.covered, observation.span);
    if (fresh > 0) {
      return { repeat: false, count: 0, covered: "", previousFingerprint };
    }
    return {
      repeat: true,
      count: prev.noProgress + 1,
      covered: describeCoverage(prev.covered),
      previousFingerprint,
    };
  }

  /**
   * Fold a completed read into its file's coverage. Call AFTER
   * `checkReadRepeat`.
   *
   * A different content fingerprint — or a different rendering — discards
   * the previous coverage outright: the lines the turn read before belong
   * to a version of the file that no longer exists, or were rendered
   * without the line numbers this read added, so counting them again
   * would mark a genuinely new read as no progress. That reset is also
   * what makes an edit-then-re-read cycle free of false warnings.
   */
  recordRead(observation: ReadObservation): void {
    const prev = this.readCoverage.get(observation.path);
    const sameVersion =
      prev !== undefined && sameReadVersion(prev, observation);
    const covered = sameVersion ? prev.covered : [];
    const fresh =
      observation.span === null
        ? 0
        : newlyCoveredCount(covered, observation.span);
    // Re-insert rather than mutate in place so the map's iteration order
    // stays "least recently read first" for eviction.
    this.readCoverage.delete(observation.path);
    this.readCoverage.set(observation.path, {
      contentHash: observation.contentHash,
      numbered: observation.numbered,
      covered:
        observation.span === null
          ? covered
          : mergeRange(covered, observation.span),
      noProgress: sameVersion && fresh === 0 ? prev.noProgress + 1 : 0,
    });
    if (this.readCoverage.size > MAX_TRACKED_READ_FILES) {
      const oldest = this.readCoverage.keys().next();
      if (!oldest.done) this.readCoverage.delete(oldest.value);
    }
  }

  /**
   * Attach a completed run's summary to its pending test-key entry so
   * the next equivalent-run warning can quote the previous result.
   */
  private noteTestOutcome(
    tool: string,
    args: unknown,
    result: CompressedToolResult,
  ): void {
    const signature = hashToolCall(tool, args);
    const key = this.pendingTestKeys.get(signature);
    if (key === undefined) return;
    this.pendingTestKeys.delete(signature);
    if (isLoopVetoResult(result)) return;
    const record = this.testRuns.get(key);
    if (record === undefined) return;
    this.testRuns.set(key, { ...record, lastSummary: result.summary });
  }

  /** Bump the consecutive-veto counter for this call's signature. */
  noteVeto(tool: string, args: unknown): void {
    const signature = hashToolCall(tool, args);
    if (this.consecutiveVetoSignature === signature) {
      this.consecutiveVetoCount += 1;
    } else {
      this.consecutiveVetoSignature = signature;
      this.consecutiveVetoCount = 1;
    }
  }

  /**
   * Whether the agent loop should escalate to a forced graceful reply.
   * True once `breakerVetoStreak` consecutive vetoes of `(tool, args)`
   * have landed.
   */
  isBreakerTripped(tool: string, args: unknown): boolean {
    const signature = hashToolCall(tool, args);
    return (
      this.consecutiveVetoSignature === signature &&
      this.consecutiveVetoCount >= this.breakerVetoStreak
    );
  }

  /**
   * How many consecutive vetoes of `(tool, args)` have landed, counting
   * the one `recordOutcome` just recorded. `0` once a DIFFERENT
   * signature's outcome has been recorded — including a sibling call in
   * the same batch, which is why this is "vetoes uninterrupted by any
   * other recorded outcome" and not "vetoes of this call". The same
   * counter gates `isBreakerTripped`, so whatever trips the breaker is
   * exactly what this returns.
   *
   * It is still the only count of calls that were refused: the
   * detector's `count` is a streak of no-progress calls, most of which
   * ran, so the two are not interchangeable in user-facing wording.
   */
  vetoStreak(tool: string, args: unknown): number {
    const signature = hashToolCall(tool, args);
    return this.consecutiveVetoSignature === signature
      ? this.consecutiveVetoCount
      : 0;
  }

  /**
   * Emit a warn at most once per bucket of `warningBucketSize` repeats so
   * the `### notice` is not re-injected every step. Returns true when the
   * caller should surface this warning. `minCount` overrides the generic
   * warning threshold for detectors with their own floor (the test-repeat
   * detector warns from the 2nd equivalent run, see
   * `TEST_REPEAT_WARNING_THRESHOLD`).
   */
  shouldEmitWarning(
    warningKey: string,
    count: number,
    minCount = this.warningThreshold,
  ): boolean {
    const threshold = Math.max(1, minCount);
    if (count < threshold) return false;
    const bucket = Math.floor((count - threshold) / this.warningBucketSize);
    const prev = this.warningBuckets.get(warningKey) ?? -1;
    if (bucket <= prev) return false;
    this.warningBuckets.set(warningKey, bucket);
    return true;
  }

  get breakerThreshold(): number {
    return this.breakerVetoStreak;
  }

  /**
   * Composite observation for a batched (multi-call) step. Hashes the
   * full call array (order-sensitive) under `BATCH_LOOP_LABEL`, records
   * it, and returns the warn/critical verdict. Permuted batches produce
   * a different hash and are not flagged as repeats.
   */
  observeBatchComposite(
    calls: readonly { tool: string; args: unknown }[],
    results: readonly CompressedToolResult[],
  ): LoopCheckVerdict {
    const argsHash = hashBatchCompositeArgs(calls);
    const noProgress = getNoProgressStreak(
      this.history,
      BATCH_LOOP_LABEL,
      argsHash,
    );
    const repeatCount = getRepeatCount(
      this.history,
      BATCH_LOOP_LABEL,
      argsHash,
    );
    let verdict: LoopCheckVerdict;
    if (noProgress.count >= this.criticalThreshold) {
      verdict = {
        level: "critical",
        count: noProgress.count,
        detector: "no_progress",
        warningKey: `critical:${BATCH_LOOP_LABEL}:${argsHash}:${noProgress.latestResultHash ?? "none"}`,
        tool: BATCH_LOOP_LABEL,
        argsHash,
      };
    } else if (repeatCount >= this.warningThreshold) {
      verdict = {
        level: "warn",
        count: repeatCount,
        detector: "generic_repeat",
        warningKey: `warn:${BATCH_LOOP_LABEL}:${argsHash}`,
        tool: BATCH_LOOP_LABEL,
        argsHash,
      };
    } else {
      verdict = {
        level: "ok",
        count: 0,
        detector: "generic_repeat",
        warningKey: `ok:${BATCH_LOOP_LABEL}:${argsHash}`,
        tool: BATCH_LOOP_LABEL,
        argsHash,
      };
    }
    this.history.push({
      tool: BATCH_LOOP_LABEL,
      argsHash,
      resultHash: hashBatchCompositeResults(calls, results),
    });
    this.trimHistory();
    return verdict;
  }

  private patchLatestPending(
    tool: string,
    args: unknown,
    patch: Partial<HistoryEntry>,
  ): void {
    const argsHash = hashToolCall(tool, args);
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const entry = this.history[i]!;
      if (entry.tool !== tool || entry.argsHash !== argsHash) continue;
      if (entry.resultHash !== undefined || entry.vetoed) continue;
      this.history[i] = { ...entry, ...patch };
      return;
    }
    // No pending entry (e.g. recordOutcome without a preceding
    // recordCall): append a finished entry so the streak still advances.
    this.history.push({ tool, argsHash, ...patch });
    this.trimHistory();
  }

  private trimHistory(): void {
    if (this.history.length > this.historySize) {
      this.history.splice(0, this.history.length - this.historySize);
    }
  }
}

/**
 * Walk history backwards counting identical `(tool, argsHash)` entries
 * whose `resultHash` matches the most recent matching result. Non-
 * matching tools are skipped (`continue`) so interleaving is tolerated;
 * a changed `resultHash` breaks the streak (`break`) so progress clears
 * it; entries without a `resultHash` (pending or vetoed) are skipped.
 */
function getNoProgressStreak(
  history: readonly HistoryEntry[],
  tool: string,
  argsHash: string,
): { count: number; latestResultHash?: string } {
  let streak = 0;
  let latestResultHash: string | undefined;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i]!;
    if (record.tool !== tool || record.argsHash !== argsHash) continue;
    if (typeof record.resultHash !== "string" || !record.resultHash) continue;
    if (latestResultHash === undefined) {
      latestResultHash = record.resultHash;
      streak = 1;
      continue;
    }
    if (record.resultHash !== latestResultHash) break;
    streak += 1;
  }
  return latestResultHash === undefined
    ? { count: streak }
    : { count: streak, latestResultHash };
}

/** Raw count of matching `(tool, argsHash)` entries in the window. */
function getRepeatCount(
  history: readonly HistoryEntry[],
  tool: string,
  argsHash: string,
): number {
  let count = 0;
  for (const record of history) {
    if (record.tool === tool && record.argsHash === argsHash) count += 1;
  }
  return count;
}
