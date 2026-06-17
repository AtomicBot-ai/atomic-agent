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
  detector: "generic_repeat" | "no_progress" | "wandering";
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
 */
export function isWanderingProneTool(tool: string): boolean {
  return (
    tool === "os.web.fetch" ||
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
      if (spread >= this.wanderingThreshold) {
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
   * caller should surface this warning.
   */
  shouldEmitWarning(warningKey: string, count: number): boolean {
    if (count < this.warningThreshold) return false;
    const bucket = Math.floor(
      (count - this.warningThreshold) / this.warningBucketSize,
    );
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
}): string {
  return formatLoopGuidance(verdict.tool, verdict.count, "notice");
}

/**
 * Body of the synthetic veto tool result (critical). Same class-aware
 * guidance as the notice, plus an explicit "do not repeat" instruction.
 */
export function formatVetoInstruction(verdict: {
  count: number;
  tool: string;
}): string {
  return formatLoopGuidance(verdict.tool, verdict.count, "veto");
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
      "- Run a web search first (the `exa-web-search` skill) to find the right page, then fetch that one URL — do not keep guessing URLs.",
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
): string {
  const header =
    mode === "veto"
      ? `BLOCKED: \`${tool}\` was vetoed as a no-progress loop (${count} identical no-progress outcomes).`
      : `You called \`${tool}\` with the same arguments ${count} times and neither the result nor the world snapshot changed.`;

  const webHint =
    tool === "os.web.fetch" || tool === "os.http.request"
      ? "- The URL may be dead or returning an HTTP error — read the status in the tool result and try a different source, endpoint, or search query."
      : null;
  const browserHint = tool.startsWith("browser.")
    ? "- Re-read `### world` — the answer may already be on the page. Try `browser.scroll`, a different element, or `browser.navigate` to a more direct URL. An `[expanded]` element is already open."
    : null;
  const shellHint =
    tool.startsWith("os.shell.") || tool.startsWith("os.fs.")
      ? "- Change the command, path, or arguments — repeating the same invocation will not produce a different result."
      : null;

  const lines = [
    header,
    "This is a no-progress loop. Change strategy BEFORE calling any tool again:",
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
