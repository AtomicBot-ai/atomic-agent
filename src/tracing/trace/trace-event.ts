import type { AgentLoopReason } from "../../agent/agent-loop.js";
import type { LlmFailureCategory } from "../../llm/reliability/index.js";
import type { MemorySubcallKind } from "../../memory/health/index.js";

/**
 * Append-only trace event emitted by the runtime for postmortem analysis
 * and prompt replay. Every event carries a monotonic `seq` within a
 * session, a wall-clock `ts`, and — when applicable — the `turnIndex` /
 * `stepIndex` context.
 *
 * Design notes:
 * - The union is `type`-discriminated so NDJSON consumers can branch on a
 *   single field.
 * - `session_started` / `trace_truncated` are the only events without a
 *   turn context; everything else carries `turnIndex`.
 * - Secret redaction is NOT applied here (NON-goal for this milestone).
 *   The sink writes payloads verbatim; consumers must treat traces as
 *   sensitive local artefacts.
 */
export type TraceEvent =
  | TraceSessionStarted
  | TraceTurnStarted
  | TraceTurnFinished
  | TraceStepStarted
  | TraceStepFinished
  | TracePromptCaptured
  | TraceLlmCompletion
  | TraceToolInvocation
  | TraceParseRetry
  | TraceBatchTrimmed
  | TraceLoopDetected
  | TraceTaskContinued
  | TraceProviderWaiting
  | TraceProviderRecovered
  | TraceCompletionTruncated
  | TracePromptRepacked
  | TraceParseFailureRecovered
  | TraceEmptyCompletionRecovered
  | TraceLessonDeprecated
  | TraceVoteApplied
  | TraceVoteRejected
  | TraceProcedureCreated
  | TraceProcedureDeprecated
  | TraceProfileClipped
  | TraceProfileFactsEvicted
  | TraceReflection
  | TraceLinkGenerator
  | TraceDistill
  | TraceQueryRewriter
  | TraceMemoryHealthWarning
  | TraceError
  | TraceTruncated;

export type TraceEventType = TraceEvent["type"];

export interface TraceEventBase {
  /** Monotonic sequence number within a session, starting at 0. */
  seq: number;
  sessionId: string;
  /** Wall-clock timestamp in milliseconds. */
  ts: number;
}

export interface TraceSessionStarted extends TraceEventBase {
  type: "session_started";
  workingDir: string;
  metadata?: Record<string, unknown>;
}

export interface TraceTurnStarted extends TraceEventBase {
  type: "turn_started";
  turnIndex: number;
  userMessage?: string;
}

export interface TraceTurnFinished extends TraceEventBase {
  type: "turn_finished";
  turnIndex: number;
  reason: AgentLoopReason;
  stepCount: number;
  durationMs: number;
}

export interface TraceStepStarted extends TraceEventBase {
  type: "step_started";
  turnIndex: number;
  stepIndex: number;
}

export interface TraceStepFinished extends TraceEventBase {
  type: "step_finished";
  turnIndex: number;
  stepIndex: number;
  summary: string;
  durationMs: number;
  /** The step kept a `reply` batched with work as a progress note. */
  progressNote?: true;
}

export interface TracePromptTokens {
  total: number;
  stablePrefix: number;
  tail: number;
}

/**
 * Captured prompt: the stable prefix is stored as a salted hash to keep
 * trace files compact (prefixes are reused byte-for-byte across steps),
 * the tail is stored verbatim so replay can reconstruct the full prompt
 * when combined with a current `stablePrefix` derived from `SessionState`.
 */
export interface TracePromptCaptured extends TraceEventBase {
  type: "prompt_captured";
  turnIndex: number;
  stepIndex: number;
  stablePrefixHash: string;
  tail: string;
  tokens: TracePromptTokens;
  slotId: number;
  cacheReused: boolean;
}

export interface TraceLlmTiming {
  promptMs: number;
  predictedMs: number;
  promptTokens: number;
  predictedTokens: number;
}

export interface TraceLlmCompletion extends TraceEventBase {
  type: "llm_completion";
  turnIndex: number;
  stepIndex: number;
  /** `1` for the initial call, `2` for the parse-retry attempt. */
  attempt: 1 | 2;
  content: string;
  reasoningContent?: string;
  timing?: TraceLlmTiming;
  /**
   * Reasoning the completion carried, in `localModels.reasoningBudgetTokens`
   * units (four characters per token — an estimate from the text, not
   * the server's count). A step cut by the budget shows `>= budget`.
   * Absent on traces recorded before F49.
   */
  reasoningTokens?: number;
  cacheHitTokens: number;
  modelId: string | null;
  stop: boolean;
  truncated: boolean;
  /** The provider's generation id, when it sent one. */
  generationId?: string;
}

export interface TraceToolInvocation extends TraceEventBase {
  type: "tool_invocation";
  turnIndex: number;
  stepIndex: number;
  tool: string;
  args: Record<string, unknown>;
  status: "ok" | "error";
  summary: string;
  details?: Record<string, unknown>;
  toolTruncated?: boolean;
  /**
   * Position of this call in the parent step's batch. `0` for solo
   * steps; `0..(batchSize-1)` for batched steps. Optional for
   * forward-compatibility with traces recorded before parallel tool
   * calls landed — old replay code that ignores the field continues
   * to work.
   */
  batchIndex?: number;
  /**
   * Total calls in the parent step. `1` for solo steps; `>=2` for
   * batched steps. Optional for back-compat (see `batchIndex`).
   */
  batchSize?: number;
}

export interface TraceParseRetry extends TraceEventBase {
  type: "parse_retry";
  turnIndex: number;
  stepIndex: number;
  attempt: number;
  reason: string;
}

/**
 * The model emitted several calls in one completion and the runtime ran
 * only `kept`: the batch held approval-gated tools that would have asked
 * someone, so it was cut to the first of them. Everything in `dropped`
 * was generated and never executed — without this row a post-mortem sees
 * one `tool_invocation` and no trace of the rest of the output.
 */
export interface TraceBatchTrimmed extends TraceEventBase {
  type: "batch_trimmed";
  turnIndex: number;
  stepIndex: number;
  /** Calls the model emitted. Always >= 2. */
  originalSize: number;
  /** The one tool that ran. */
  kept: string;
  /** Tools that never ran, in emitted order. */
  dropped: string[];
  /** Tools the turn's policy would have refused anyway; omitted when none. */
  refused?: string[];
  reason: "approval-gated-batched";
}

/**
 * A leg of the task finished and the work carried on. The trace is
 * where "did it stop, or is it still going?" gets answered after the
 * fact, so the two numbers that decide it are both here.
 */
export interface TraceTaskContinued extends TraceEventBase {
  type: "task_continued";
  turnIndex: number;
  stepsTaken: number;
  elapsedMs: number;
  stepCeiling: number;
}

/** The turn was parked because the provider stopped answering. */
export interface TraceProviderWaiting extends TraceEventBase {
  type: "provider_waiting";
  turnIndex: number;
  stepIndex?: number;
  attempt: number;
  waitedMs: number;
  maxWaitMs: number;
  nextRetryMs: number;
  reason: string;
}

/**
 * A completion could not be read as tool calls and the turn spent
 * another step on it instead of ending. This is the row that explains
 * an inference with no tool call and no text behind it — without it a
 * post-mortem sees a step that simply did nothing.
 */
export interface TraceParseFailureRecovered extends TraceEventBase {
  type: "parse_failure_recovered";
  turnIndex: number;
  stepIndex: number;
  attempt: number;
  budget: number;
  reason: string;
}

/**
 * A completion came back with nothing in any channel and the turn spent
 * another step on it instead of ending. Distinct from
 * `parse_failure_recovered`: there was no output to reject, so a
 * post-mortem reading a `reason` here would be reading a fiction.
 */
export interface TraceEmptyCompletionRecovered extends TraceEventBase {
  type: "empty_completion_recovered";
  turnIndex: number;
  stepIndex: number;
  attempt: number;
  budget: number;
}

/** The provider answered again and the parked turn resumed. */
export interface TraceProviderRecovered extends TraceEventBase {
  type: "provider_recovered";
  turnIndex: number;
  waitedMs: number;
}

/**
 * A reply the server cut short is being retried with a different
 * request. `retry` says which: `raise_cap` with the new cap in
 * `retryValue`, or `fit_window` with the learned context window.
 */
export interface TraceCompletionTruncated extends TraceEventBase {
  type: "completion_truncated";
  turnIndex: number;
  stepIndex: number;
  cause:
    | "reply_cap"
    | "context_window"
    | "output_limit"
    | "provider_limit"
    | "unknown";
  completionTokens: number;
  promptTokens: number;
  /** The cap the cut request carried; absent when it carried none. */
  requestedMaxTokens?: number;
  retry: "raise_cap" | "fit_window";
  retryValue: number;
}

/**
 * The provider refused the request for its size; the window was learned
 * and the step is being retried with the conversation packed to it.
 */
export interface TracePromptRepacked extends TraceEventBase {
  type: "prompt_repacked";
  turnIndex: number;
  stepIndex: number;
  contextWindow: number;
  source: "provider" | "estimate";
  promptTokens: number;
}

export interface TraceLoopDetected extends TraceEventBase {
  type: "loop_detected";
  turnIndex: number;
  stepIndex: number;
  tool: string;
  count: number;
  /**
   * Graduated severity from the `ToolLoopTracker`:
   *  - `warn`: args-only repeat — a `### notice` was injected.
   *  - `critical`: identical args+result streak — the call was vetoed.
   *  - `breaker`: repeated vetoes ignored — a graceful reply was forced.
   * Optional for back-compat with traces recorded before phase 7.
   */
  level?: "warn" | "critical" | "breaker";
  /** Which sub-detector fired. Optional for back-compat. */
  detector?:
    | "generic_repeat"
    | "no_progress"
    | "wandering"
    | "test_repeat"
    | "read_repeat"
    | "outcome_repeat";
  /**
   * `read_repeat` only (issue #114): the canonical file the reads landed
   * on, the line range the triggering read returned, and the content
   * fingerprint before and after it — equal fingerprints are what make
   * the re-read redundant, so both are recorded and a trace reader can
   * check the claim. Never carries file content.
   */
  read?: {
    path: string;
    startLine: number;
    endLine: number;
    previousFingerprint: string;
    fingerprint: string;
  };
}

/**
 * Memory-v2 phase 6. Cold-path event emitted when the consolidator
 * demotes a lesson. `reason ∈ {"aged_out", "overflow", ...}` —
 * phase 7a will add `"downvoted"`. Lives outside any
 * `turnIndex`/`stepIndex` context (the consolidator runs out-of-band
 * via its own `setInterval`); `sessionId` carries the synthetic
 * `consolidator` correlation tag set by `ConsolidatorJob`.
 */
export interface TraceLessonDeprecated extends TraceEventBase {
  type: "lesson_deprecated";
  lessonId: number;
  reason: string;
}

/**
 * Memory-v2 phase 7a. A single vote was applied to memory / lesson /
 * profile via `VoteRunner`. One event per vote, fired by the
 * reflection slot. The `score` field is the clamped post-write
 * `vote_score` of the target so postmortems can reconstruct the
 * decay curve without re-deriving it from `vote_events`.
 */
export interface TraceVoteApplied extends TraceEventBase {
  type: "vote_applied";
  kind: "memory" | "lesson" | "profile" | "procedure";
  targetId: number;
  direction: 1 | -1;
  score: number;
  /** `true` when the clamp pinned the score at the bound. */
  clampHit: boolean;
}

/**
 * Memory-v2 phase 7a. The LLM emitted a vote that was rejected
 * before reaching the store — most commonly because the target was
 * not in the per-turn allowlist (cross-phase invariant 18). The
 * `reason` field is the same short tag the metrics counter uses
 * (`out_of_allowlist`, `target_missing`, `malformed`, ...). One
 * event per rejection.
 */
export interface TraceVoteRejected extends TraceEventBase {
  type: "vote_rejected";
  kind: "memory" | "lesson" | "profile" | "procedure" | "unknown";
  targetId: number | null;
  direction: 1 | -1 | null;
  reason: string;
}

/**
 * Memory-v2 phase 7b. The consolidator persisted a new advisory
 * procedure (read-only "how-to" template) together with its parent
 * lesson. One event per persisted procedure. Cross-phase invariant
 * 21: still a single LLM call per cluster — this is the second
 * write produced by that single completion. `parentLessonIds` is
 * the materialised array (typically one entry — the lesson that
 * came out of the same `LESSON+PROCEDURE` distillation), and
 * `parentMemoryIds` is the cluster member set archived by the
 * companion `archiveInto` call. `source` reflects whether the row
 * came from the cold-path consolidator or, in the future, a
 * manual / replay path.
 */
export interface TraceProcedureCreated extends TraceEventBase {
  type: "procedure_created";
  procedureId: number;
  parentLessonIds: readonly number[];
  parentMemoryIds: readonly number[];
  source: "consolidator" | "manual";
}

/**
 * Memory-v2 phase 7b. A procedure was demoted to
 * `status='deprecated'`. `reason` is the same short tag the
 * `agent.memory.procedures.deprecated` metric carries —
 * `parent_deprecated` (cascade from lesson sweep), `aged_out`
 * (age-based), `downvoted` (vote-driven), or `overflow` (FIFO cap).
 */
export interface TraceProcedureDeprecated extends TraceEventBase {
  type: "procedure_deprecated";
  procedureId: number;
  reason: string;
}

/**
 * Issue #407. `### profile` did not fit `memory.profile.maxTokens` and
 * whole fact lines were left out of the prompt. Counts only, never a
 * key or a value. Emitted once per session, and again only when the
 * number of pinned facts left out changes — the clip itself runs on
 * every step.
 */
export interface TraceProfileClipped extends TraceEventBase {
  type: "profile_clipped";
  turnIndex: number;
  stepIndex: number;
  rendered: number;
  dropped: number;
  pinnedDropped: number;
  maxTokens: number;
}

/**
 * Issue #407. A profile write pushed the active unpinned facts over
 * `memory.profile.maxEntries` and the lowest-utility ones were deleted
 * in the same transaction. Pinned facts are never evicted. `keys` names
 * what was lost, so it is content: `/report` strips it.
 */
export interface TraceProfileFactsEvicted extends TraceEventBase {
  type: "profile_facts_evicted";
  maxEntries: number;
  /** Active unpinned facts left after the eviction. */
  activeUnpinned: number;
  evicted: number;
  ids: readonly number[];
  keys: readonly string[];
}

/**
 * Memory-v2. End-of-turn reflection sub-call outcome (SET/NOTE/EVOLVE
 * extraction). Emitted once per `ReflectionRunner.reflect` call by the
 * reflection slot. Reflection fires fire-and-forget after
 * `turn_finished`, so the recorder owns the monotonic `seq` and the
 * event interleaves into the same per-session NDJSON file. `outcome`
 * mirrors `agent.memory.reflection` metric tags.
 */
export interface TraceReflection extends TraceEventBase {
  type: "reflection";
  outcome: "ok" | "none" | "aborted" | "timeout" | "failed";
  factsWritten?: number;
  notesWritten?: number;
  reason?: string;
}

/**
 * Memory-v2 phase 2. Reactive link-graph generation sub-call outcome.
 * Emitted once per `LinkGeneratorRunner.generate` call. `outcome`
 * mirrors `agent.memory.link_generator` metric tags; `linksWritten`
 * is the count of edges persisted this turn.
 */
export interface TraceLinkGenerator extends TraceEventBase {
  type: "link_generator";
  outcome: "ok" | "none" | "skipped" | "aborted" | "timeout" | "failed";
  linksWritten?: number;
  candidates?: number;
  reason?: string;
}

/**
 * Memory-v2 phase 5/7b. Cold-path consolidator distillation outcome
 * for one cluster. Lives outside any turn context (the consolidator
 * runs out-of-band via its own `setInterval`); `sessionId` carries
 * the synthetic `consolidator` correlation tag, sharing the
 * `consolidator.ndjson` file + seq counter with `lesson_deprecated`
 * and the `procedure_*` events. `hasProcedure` is `true` when the
 * single combined LLM call also emitted a `PROCEDURE` half.
 */
export interface TraceDistill extends TraceEventBase {
  type: "distill";
  outcome: "ok" | "none" | "aborted" | "timeout" | "failed";
  clusterSize?: number;
  hasProcedure?: boolean;
  reason?: string;
}

/**
 * Memory v2.5 phase A. Recall-side query-rewriter sub-call outcome.
 * Emitted once per `QueryRewriterRunner.maybeRewrite` call (the
 * rewriter runs during `refreshMemoryContext` before the step loop).
 * `outcome` mirrors `agent.memory.retrieve.rewriter` metric tags —
 * `skipped_*` outcomes mean the heuristic / embedding gate declined
 * to fire the LLM call.
 */
export interface TraceQueryRewriter extends TraceEventBase {
  type: "query_rewriter";
  outcome:
    | "ok"
    | "skipped_not_referential"
    | "skipped_no_history"
    | "aborted"
    | "timeout"
    | "failed";
  reason?: string;
}

/**
 * The operator was told that a memory sub-call keeps timing out or
 * failing. At most one row per session and `kind` — the warning is
 * once-only. `setting` is the config key the notice named; `reason` the
 * summarised last failure (absent when the streak ended in a timeout).
 * The per-call `reflection` / `link_generator` / `query_rewriter` rows
 * before it are the streak itself.
 */
export interface TraceMemoryHealthWarning extends TraceEventBase {
  type: "memory_health_warning";
  turnIndex: number;
  kind: MemorySubcallKind;
  outcome: "timeout" | "failed";
  consecutive: number;
  setting: string;
  reason?: string;
}

export interface TraceError extends TraceEventBase {
  type: "error";
  turnIndex?: number;
  stepIndex?: number;
  message: string;
  stack?: string;
  /**
   * The provider's generation id when the failure came from a stream
   * that had already produced output — the tokens are billed, and the
   * id is what recovers the cost.
   */
  generationId?: string;
  /**
   * Canonical LLM failure taxonomy tag
   * (`transport` / `grammar` / `model` / `tool` / `cancelled`). Missing
   * only on legacy traces recorded before the taxonomy was introduced;
   * new traces always carry it.
   */
  category?: LlmFailureCategory;
  /**
   * Fallback-chain links that failed before the one `message` came from —
   * present only when the chain fell over, or the turn was already on a
   * fallback, before failing. `message` stays that last link's verbatim.
   */
  fallbackFailures?: { providerId: string; reason: string }[];
}

/**
 * Synthetic marker written by the NDJSON sink at the seam where it
 * dropped the oldest part of a trace file to stay under
 * `maxBytesPerSession`. It is NOT terminal: events keep being appended
 * after it. Its job is to stop a reader — human or agent — from taking
 * the row that follows it for the start of the session.
 *
 * `seq` and `ts` are those of the LAST dropped event, so the file stays
 * ordered by both and the marker sits exactly where the gap ends.
 */
export interface TraceTruncated extends TraceEventBase {
  type: "trace_truncated";
  reason: string;
  /**
   * Events removed from the head of this file so far, across every
   * trim it has been through. Optional: traces recorded before the
   * sink learned to keep the tail carry a marker without it.
   */
  droppedEvents?: number;
  /** Bytes of event data removed so far. Optional, as `droppedEvents`. */
  droppedBytes?: number;
}

/** Stable JSON serialization: one event per line, trailing newline. */
export function serializeTraceEvent(event: TraceEvent): string {
  return `${JSON.stringify(event)}\n`;
}
