import { createHash } from "node:crypto";
import type { CompressedToolResult } from "../compressor/result-compressor.js";

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

export type LoopCheckLevel = "ok" | "warn" | "critical";

/**
 * Equivalent-run count at which the test-repeat detector (issue #118)
 * warns: the 2nd recognized test command against an unchanged workspace
 * fingerprint is already conclusive (the suite cannot produce new
 * evidence), unlike the generic byte-repeat where a rerun may be an
 * intentional retry. Warn-only — never routed into the veto/breaker.
 */
export const TEST_REPEAT_WARNING_THRESHOLD = 2;

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
   * Distinct-args spread on a wandering-prone tool that fires a
   * `wandering` warn (actionable redirect). Min 2. Default 6.
   */
  wanderingThreshold?: number;
  /**
   * Distinct-args spread on a wandering-prone tool that escalates to a
   * forced graceful reply (the redirect did not land). Default 12.
   */
  wanderingEscalation?: number;
}

export interface LoopCheckVerdict {
  level: LoopCheckLevel;
  /**
   * Repeat count (warn), no-progress streak length (critical), or
   * distinct-args spread (wandering).
   */
  count: number;
  detector: "generic_repeat" | "no_progress" | "wandering" | "test_repeat";
  /** Stable key for warn de-duplication and breaker signalling. */
  warningKey: string;
  tool: string;
  argsHash: string;
}

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
  return (
    tool === "os.web.fetch" ||
    tool === "os.web.search" ||
    tool === "os.http.request" ||
    tool.startsWith("browser.")
  );
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
      const spread = this.effectiveSpread(tool, argsHash);
      // The spread is a property of the whole window, so it stays above the
      // threshold after the model stops varying its argument and settles on
      // repeating one. Classifying THIS call as wandering would then tell it
      // "N different attempts" about a call that is a verbatim repeat -- the
      // same kind of false statement the wandering wording exists to avoid.
      // A repeat falls through to the repeat detector, which describes it
      // accurately.
      const repeatsEarlierCall =
        getRepeatCount(this.history, tool, argsHash) > 0;
      if (spread >= this.wanderingThreshold && !repeatsEarlierCall) {
        return {
          level: "warn",
          count: spread,
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
   * Whether the wandering spread on `(tool, args)` has crossed the
   * escalation threshold. Pure — call BEFORE `recordCall` (the prospective
   * call is folded in via `effectiveSpread`). The agent loop maps a `true`
   * here onto the breaker path (forced graceful reply).
   */
  isWanderingEscalated(tool: string, args: unknown): boolean {
    if (!isWanderingProneTool(tool)) return false;
    const argsHash = hashToolCall(tool, args);
    return this.effectiveSpread(tool, argsHash) >= this.wanderingEscalation;
  }

  /**
   * Distinct count of completed (non-veto) `argsHash`es seen for `tool` in
   * the window, plus one when the prospective call introduces a new
   * signature (the current call is not yet in history at `check` time).
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
   */
  recordOutcome(tool: string, args: unknown, result: CompressedToolResult): void {
    this.noteTestOutcome(tool, args, result);
    if (isLoopVetoResult(result)) {
      this.patchLatestPending(tool, args, { vetoed: true });
      this.noteVeto(tool, args);
      return;
    }
    const resultHash = hashToolOutcome(tool, args, result);
    if (resultHash === undefined) return;
    this.patchLatestPending(tool, args, { resultHash });
    if (this.consecutiveVetoSignature !== null) {
      const sig = hashToolCall(tool, args);
      if (sig !== this.consecutiveVetoSignature) {
        this.consecutiveVetoSignature = null;
        this.consecutiveVetoCount = 0;
      }
    }
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
    const repeatCount = getRepeatCount(this.history, BATCH_LOOP_LABEL, argsHash);
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

/** True when `result` is a synthetic no-progress loop veto. */
export function isLoopVetoResult(result: CompressedToolResult): boolean {
  return (
    result.status === "error" &&
    result.details.deniedReason === LOOP_VETO_DENIED_REASON
  );
}

/** Stable signature for a `(tool, args)` pair. */
export function hashToolCall(tool: string, args: unknown): string {
  return `${tool}:${hashCanonical(args)}`;
}

/**
 * Semantic result hash. Returns `undefined` for loop-veto results (so the
 * vetoed entry is excluded from the no-progress streak). Errors collapse
 * to a stable `error:<hash>`; `os.shell.run` normalises by exit code +
 * summary; everything else hashes the compressed summary + details.
 */
export function hashToolOutcome(
  tool: string,
  _args: unknown,
  result: CompressedToolResult,
): string | undefined {
  if (isLoopVetoResult(result)) return undefined;
  if (result.status === "error") {
    const errorName =
      typeof result.details.errorName === "string"
        ? result.details.errorName
        : "error";
    return `error:${hashString(`${errorName}:${result.summary}`)}`;
  }
  if (tool === "os.shell.run") {
    const exitCode =
      typeof result.details.exitCode === "number"
        ? result.details.exitCode
        : null;
    return hashString(`shell:${exitCode}:${result.summary}`);
  }
  // Strip volatile fields (per-call timings, sizes, request ids, dates)
  // before hashing so that semantically identical responses collapse to
  // the same hash. Without this, fields like `timeTotalSeconds` /
  // `sizeDownload` change on every call and a repeated dead/identical
  // endpoint (e.g. 21 identical search POSTs) never registers as a
  // no-progress streak. Mirrors OpenClaw's `stripVolatileSendIds`.
  return hashString(
    `${result.summary}:${hashCanonical(stripVolatile(result.details))}`,
  );
}

/**
 * Result-detail keys whose values change on every call even when the
 * response is semantically identical. Dropped before the no-progress hash
 * so identical-but-for-volatile responses match.
 */
const VOLATILE_RESULT_KEYS = new Set<string>([
  "timestamp",
  "ts",
  "date",
  "time",
  "timeTotal",
  "timeTotalSeconds",
  "durationMs",
  "sizeDownload",
  "requestId",
  "request_id",
  "id",
  "traceId",
  "trace_id",
  "sentAt",
  "createdAt",
  "deliveredAt",
]);

/** Recursively drop `VOLATILE_RESULT_KEYS` from an arbitrary value. */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value === null || typeof value !== "object") return value;
  const stripped: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (VOLATILE_RESULT_KEYS.has(key)) continue;
    stripped[key] = stripVolatile(nested);
  }
  return stripped;
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

function hashBatchCompositeArgs(
  calls: readonly { tool: string; args: unknown }[],
): string {
  return hashCanonical(calls.map((c) => [c.tool, c.args]));
}

function hashBatchCompositeResults(
  calls: readonly { tool: string; args: unknown }[],
  results: readonly CompressedToolResult[],
): string {
  return hashCanonical(
    calls.map((c, i) => ({
      tool: c.tool,
      summary: results[i]?.summary ?? "",
      status: results[i]?.status ?? "error",
    })),
  );
}

function hashString(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function hashCanonical(value: unknown): string {
  return hashString(canonicalJson(value));
}

/**
 * Deterministic JSON serialisation: object keys sorted, arrays preserved
 * in order, `undefined` omitted.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",");
  return `{${body}}`;
}

/**
 * Notice injected into the next prompt's `### notice` section when a
 * repeat is detected (warn). Class-aware so the hint is actionable.
 */
export function formatRepeatNotice(verdict: {
  count: number;
  tool: string;
  target?: string;
}): string {
  return formatLoopGuidance(verdict.tool, verdict.count, "notice", verdict);
}

/**
 * Body of the synthetic veto tool result (critical). Same class-aware
 * guidance as the notice, plus an explicit "do not repeat" instruction.
 *
 * `target` names the invariant that stayed the same across the blocked
 * attempts (host for web/HTTP calls, command name for shell). `detector`
 * distinguishes a true no-progress repeat from a `wandering` escalation
 * riding the same veto path — the two need opposite wording, because a
 * wandering `count` is a spread of DISTINCT arguments, not a run of
 * identical outcomes.
 */
export function formatVetoInstruction(verdict: {
  count: number;
  tool: string;
  target?: string;
  detector?: LoopCheckVerdict["detector"];
}): string {
  return formatLoopGuidance(verdict.tool, verdict.count, "veto", verdict);
}

/**
 * Notice injected when a recognized test command was re-run against an
 * unchanged workspace (issue #118, warn-only). The run has already
 * executed when the model reads this — the wording is therefore an
 * after-the-fact nudge, not a block, and explicitly leaves the
 * intentional-repeat path open (nothing is vetoed; the generic loop
 * protection stays fully active either way).
 */
export function formatTestRepeatNotice(verdict: {
  count: number;
  target?: string;
  previousSummary?: string;
}): string {
  const target = sanitizeLoopTarget(verdict.target);
  const label = target ? `\`${target}\`` : "the same test command";
  const lines = [
    `You ran ${label} ${verdict.count} times with no workspace change in between. No project file changed since the previous run, so this run could not produce new evidence.`,
  ];
  if (verdict.previousSummary !== undefined) {
    const summary = sanitizeTestSummary(verdict.previousSummary);
    if (summary !== undefined) {
      lines.push(`Previous result: ${summary}`);
    }
  }
  lines.push(
    "Change the code or the test selection before re-running. If the repeat was intentional (e.g. probing for flakiness), continue — this is a warning, nothing was blocked.",
  );
  return lines.join("\n");
}

/**
 * Compact a previous-result summary for inline quoting in a notice:
 * whitespace collapsed to one line, length-capped. Returns `undefined`
 * for an empty summary so the caller omits the line entirely.
 */
function sanitizeTestSummary(raw: string): string | undefined {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > 300 ? `${cleaned.slice(0, 297)}...` : cleaned;
}

/**
 * Notice injected when a wandering loop is detected (warn-level). Unlike
 * the repeat veto ("do not do X"), this is an actionable redirect ("do Y
 * instead"): the model has probed many distinct URLs/queries/pages on one
 * tool without converging, so steer it toward search or an honest reply.
 */
export function formatWanderingRedirect(tool: string, spread: number): string {
  const lines = [
    `You have called \`${tool}\` with ${spread} different arguments this turn without converging on the answer.`,
    "This is a wandering loop. STOP probing more URLs/pages and change strategy:",
  ];
  if (tool === "os.web.fetch" || tool === "os.http.request") {
    lines.push(
      "- Run `os.web.search` first to find the right page, then fetch that one URL — do not keep guessing URLs.",
    );
  } else if (tool.startsWith("browser.")) {
    lines.push(
      "- Re-read `### world`; the answer may already be on the page. Navigate to a single more-direct URL or run a search instead of clicking around.",
    );
  }
  lines.push(
    "- If you already have enough information, end the turn with `reply` and your best-effort answer.",
  );
  return lines.join("\n");
}

/**
 * Synthetic assistant reply emitted when the breaker fires (the model
 * ignored repeated vetoes). Reused by the agent loop's forced graceful
 * termination path.
 */
export function formatForcedLoopReply(tool: string, count: number): string {
  return [
    `(stopped: stuck in a no-progress loop on \`${tool}\` after ${count} blocked attempts).`,
    "I could not make further progress with the repeated tool call.",
    "Here is my best answer with the information gathered so far — the task may be incomplete.",
  ].join(" ");
}

function formatLoopGuidance(
  tool: string,
  count: number,
  mode: "notice" | "veto",
  context: {
    target?: string;
    detector?: LoopCheckVerdict["detector"];
  } = {},
): string {
  const target = sanitizeLoopTarget(context.target);
  const wandering = context.detector === "wandering";

  let header: string;
  if (mode === "veto" && wandering) {
    // Wandering: `count` is a spread of DISTINCT arguments, so calling
    // these "identical outcomes" would be flatly wrong.
    header = target
      ? `BLOCKED: \`${tool}\` — ${count} different attempts against \`${target}\` and still no answer.`
      : `BLOCKED: \`${tool}\` — ${count} different attempts and still no answer.`;
  } else if (mode === "veto" && count > 1) {
    header = target
      ? `BLOCKED: \`${tool}\` — ${count} consecutive calls to \`${target}\` returned the same no-progress outcome.`
      : `BLOCKED: \`${tool}\` — ${count} consecutive calls returned the same no-progress outcome.`;
  } else if (mode === "veto") {
    // The breaker can fire on a verdict that carries no streak of its own
    // (a wandering episode the model ended by settling on one argument).
    // State only what is certainly true rather than quoting a count that
    // would read as "0 consecutive calls".
    header = target
      ? `BLOCKED: \`${tool}\` — repeated calls to \`${target}\` are not making progress.`
      : `BLOCKED: \`${tool}\` — repeated calls are not making progress.`;
  } else {
    header = target
      ? `You called \`${tool}\` on \`${target}\` ${count} times with the same arguments and neither the result nor the world snapshot changed.`
      : `You called \`${tool}\` with the same arguments ${count} times and neither the result nor the world snapshot changed.`;
  }

  // Actionable alternative, modelled on the wandering redirect: name the
  // next move, do not restate the failure mode.
  let webHint: string | null = null;
  if (tool === "os.web.fetch" || tool === "os.http.request") {
    if (wandering && target) {
      webHint = `- Stop guessing URLs on \`${target}\`. Run \`os.web.search\` for the fact you need and fetch a result from a DIFFERENT host.`;
    } else if (target) {
      webHint = `- Run \`os.web.search\` for the fact you need and fetch a result from a DIFFERENT host — stop retrying \`${target}\`. The URL may be dead or returning an HTTP error; read the status in the tool result.`;
    } else {
      webHint =
        "- Run `os.web.search` for the fact you need, then fetch one URL from the results — do not keep guessing URLs. The URL may be dead or returning an HTTP error; read the status in the tool result.";
    }
  }
  const browserHint = tool.startsWith("browser.")
    ? "- Re-read `### world` — the answer may already be on the page. Try `browser.scroll`, a different element, or `browser.navigate` to a more direct URL. An `[expanded]` element is already open."
    : null;
  const shellHint =
    tool.startsWith("os.shell.") || tool.startsWith("os.fs.")
      ? target
        ? `- \`${target}\` will not behave differently on a re-run — change the arguments or path, or use a different command entirely.`
        : "- Change the command, path, or arguments — repeating the same invocation will not produce a different result."
      : null;

  const lines = [
    header,
    "Change strategy BEFORE calling any tool again:",
    webHint,
    browserHint,
    shellHint,
    "- If you have enough information already, end the turn with `reply`.",
    mode === "veto"
      ? "- Do NOT repeat this exact call. Either try a different approach or close the turn with `reply` giving your best answer / honestly report you could not complete the task."
      : null,
  ].filter((line): line is string => line !== null);

  return lines.join("\n");
}

/**
 * Defensive cleanup for a caller-supplied invariant label before it is
 * echoed into model context: single line, no backticks (they would break
 * the surrounding code span), length-capped. Returns `undefined` for
 * anything empty so callers degrade to the generic wording.
 */
function sanitizeLoopTarget(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/[`\r\n]+/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
}

/**
 * Extract the invariant that stayed the same across a loop's blocked
 * attempts, for use as the `target` label in guidance messages.
 *
 * Deliberately coarse: web/HTTP calls collapse to the URL's HOST and
 * shell calls to the leading command word, so no query parameters,
 * credentials, paths, or other potentially sensitive argument content
 * reaches the model context. Returns `undefined` when nothing meaningful
 * can be extracted, so the caller falls back to the generic wording.
 * Never throws on malformed args.
 */
export function extractLoopTarget(
  tool: string,
  args: unknown,
): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;

  if (tool === "os.web.fetch" || tool === "os.http.request") {
    const raw = record.url ?? record.uri ?? record.endpoint;
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
      ? raw
      : `https://${raw}`;
    try {
      const host = new URL(candidate).hostname;
      return host.length > 0 ? host : undefined;
    } catch {
      return undefined;
    }
  }

  if (tool === "os.shell.run") {
    const raw = record.command ?? record.cmd;
    if (typeof raw !== "string") return undefined;
    // Leading word only: the executable name, never the full argv.
    const name = raw.trim().split(/\s+/)[0];
    return name !== undefined && name.length > 0 ? name : undefined;
  }

  return undefined;
}
