import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

import { VOTE_GRAMMAR } from "./vote-grammar.js";
import {
  buildVotePrompt,
  type VoteCandidate,
} from "./vote-prompt.js";
import {
  parseVoteOutput,
  type ParsedVote,
  type ParseRejection,
  type VoteAllowlist,
} from "./vote-parser.js";
import { VoteStore, VoteValidationError } from "./vote-store.js";

/**
 * Memory-v2 phase 7a. Fire-and-forget runner that asks the
 * reflection LLM to vote on items surfaced in the current turn,
 * then applies the results via `VoteStore`.
 *
 * Architectural notes:
 *   - Lives on the **shared** reflection slot per the scope
 *     decision for this phase (see AGENTS.md Phase 7a). KV-cache
 *     impact is mitigated by keeping the micro-prompt small and
 *     emitting at most one vote sub-call per turn.
 *   - Same per-session in-flight semantics as
 *     `LinkGeneratorRunner.generate`: a second call on the same
 *     session aborts the first one; calls on different sessions
 *     never abort each other (cross-phase invariant 7 in
 *     MEMORY_FABRIC_V2.md §13.7).
 *   - Fire-safe: `run()` never throws. Failures are logged +
 *     counted into `agent.memory.voting.runner` and per-reason
 *     counters; nothing else in the agent loop notices.
 *   - The parser's allowlist is the load-bearing anti-feedback-loop
 *     guard (cross-phase invariant 18). The runner builds the
 *     allowlist verbatim from `input.candidates` so the parser
 *     and the prompt always agree on which `(kind, id)` pairs are
 *     legitimate.
 */
export interface VoteRunnerInput {
  sessionId: string;
  userMessage: string;
  assistantReply: string;
  /**
   * Surfaced items eligible to vote on. Every `(kind, id)` pair
   * must be one that actually rendered in this turn's variable
   * tail — the parser drops anything else via the allowlist.
   */
  candidates: ReadonlyArray<VoteCandidate>;
  /** Optional 0-based turn index for audit log attribution. */
  turnIndex?: number;
}

export type VoteRunnerOutcome =
  | "ok"
  | "none"
  | "skipped"
  | "aborted"
  | "timeout"
  | "failed";

export interface VoteRunnerResult {
  outcome: VoteRunnerOutcome;
  applied: number;
  rejected: number;
}

export interface VoteRunner {
  /**
   * Fire-safe. Never throws. Returns the per-call summary
   * primarily for tests — the agent loop never inspects the
   * result.
   */
  run(input: VoteRunnerInput): Promise<VoteRunnerResult>;
  /**
   * Cancels in-flight vote calls. Same per-session semantics as
   * `ReflectionRunner.abortPending`.
   */
  abortPending(options?: { sessionId?: string }): void;
}

export type VoteRunnerLlmComplete = (params: {
  prompt: string;
  grammar: string;
  slotId: number;
  sessionId: string;
  signal: AbortSignal;
}) => Promise<CompletionResult>;

export type VoteTraceEvent =
  | {
      type: "applied";
      sessionId: string;
      kind: "memory" | "lesson" | "profile";
      targetId: number;
      direction: 1 | -1;
      score: number;
      clampHit: boolean;
    }
  | {
      type: "rejected";
      sessionId: string;
      kind: "memory" | "lesson" | "profile" | "unknown";
      targetId: number | null;
      direction: 1 | -1 | null;
      reason: string;
    };

export interface VoteRunnerDeps {
  llmComplete: VoteRunnerLlmComplete;
  voteStore: VoteStore;
  /** Same slot as reflection — invariant 7. */
  reflectionSlotId: number;
  /** Hard timeout per vote call. */
  timeoutMs: number;
  /** Hard ceiling on `|vote_score|`. Mirrors `memory.voting.maxVotePerItem`. */
  maxVotePerItem: number;
  /** Hard cap on emitted votes per call. Mirrors `memory.voting.maxVotesPerCall` (defaults to 8). */
  maxVotesPerCall?: number;
  /** FIFO cap on the `vote_events` audit log. `0` disables eviction. */
  eventLogMaxRows: number;
  /** Minimum candidate count below which we skip the LLM call entirely. */
  minCandidates?: number;
  logger?: StructuredLogger;
  metrics?: AgentMetrics;
  /**
   * Memory-v2 phase 7a. Optional trace sink invoked once per
   * applied / rejected vote. Bootstrap binds this to the
   * per-session `TraceRecorder.recordVoteApplied` /
   * `recordVoteRejected` methods so the events land in the same
   * NDJSON file as the rest of the session's trace, with a
   * monotonic `seq` owned by the recorder. Errors are swallowed
   * by the call site so a sink hiccup never derails vote
   * application.
   */
  emitTrace?: (event: VoteTraceEvent) => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

export function createVoteRunner(deps: VoteRunnerDeps): VoteRunner {
  const now = deps.now ?? Date.now;
  const pending = new Map<string, AbortController>();
  const maxVotesPerCall = deps.maxVotesPerCall ?? 8;
  const minCandidates = deps.minCandidates ?? 1;

  const finish = (
    outcome: VoteRunnerOutcome,
    context: {
      sessionId: string;
      startedAt: number;
      applied?: number;
      rejected?: number;
      reason?: string;
    },
  ): VoteRunnerResult => {
    const tookMs = Math.max(0, now() - context.startedAt);
    const result: VoteRunnerResult = {
      outcome,
      applied: context.applied ?? 0,
      rejected: context.rejected ?? 0,
    };
    deps.metrics?.recordVotingRunner({
      sessionId: context.sessionId,
      outcome,
      durationMs: tookMs,
      applied: result.applied,
      rejected: result.rejected,
    });
    const logContext = {
      sessionId: context.sessionId,
      tookMs,
      applied: result.applied,
      rejected: result.rejected,
      ...(context.reason ? { reason: context.reason } : {}),
    };
    switch (outcome) {
      case "ok":
        deps.logger?.info("voting.runner.ok", logContext);
        return result;
      case "none":
        deps.logger?.debug("voting.runner.none", logContext);
        return result;
      case "skipped":
        deps.logger?.debug("voting.runner.skipped", logContext);
        return result;
      case "aborted":
        deps.logger?.debug("voting.runner.aborted", logContext);
        return result;
      case "timeout":
        deps.logger?.warn("voting.runner.timeout", logContext);
        return result;
      case "failed":
        deps.logger?.warn("voting.runner.failed", logContext);
        return result;
    }
  };

  const runOne = async (
    input: VoteRunnerInput,
  ): Promise<VoteRunnerResult> => {
    if (input.candidates.length < minCandidates) {
      return finish("skipped", {
        sessionId: input.sessionId,
        startedAt: now(),
      });
    }
    const previous = pending.get(input.sessionId);
    if (previous) previous.abort();
    const controller = new AbortController();
    pending.set(input.sessionId, controller);
    const startedAt = now();
    deps.logger?.debug("voting.runner.fired", {
      sessionId: input.sessionId,
      candidates: input.candidates.length,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deps.timeoutMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }

    try {
      const prompt = buildVotePrompt({
        userMessage: input.userMessage,
        assistantReply: input.assistantReply,
        candidates: input.candidates,
      });
      const completion = await deps.llmComplete({
        prompt,
        grammar: VOTE_GRAMMAR,
        slotId: deps.reflectionSlotId,
        sessionId: `vote:${input.sessionId}`,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        return finish(timedOut ? "timeout" : "aborted", {
          sessionId: input.sessionId,
          startedAt,
        });
      }
      const allowlist = buildAllowlist(input.candidates);
      const parsed = parseVoteOutput(completion.content, {
        allowlist,
        maxVotes: maxVotesPerCall,
      });
      if (parsed.kind === "none") {
        return finish("none", {
          sessionId: input.sessionId,
          startedAt,
        });
      }
      const { applied, rejected } = applyVotes(
        parsed.votes,
        parsed.rejected,
        deps.voteStore,
        {
          sessionId: input.sessionId,
          turnIndex: input.turnIndex,
          maxVotePerItem: deps.maxVotePerItem,
          eventLogMaxRows: deps.eventLogMaxRows,
          metrics: deps.metrics,
          logger: deps.logger,
          ...(deps.emitTrace ? { emitTrace: deps.emitTrace } : {}),
        },
      );
      const outcome: VoteRunnerOutcome = applied > 0 ? "ok" : "none";
      return finish(outcome, {
        sessionId: input.sessionId,
        startedAt,
        applied,
        rejected,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        return finish(timedOut ? "timeout" : "aborted", {
          sessionId: input.sessionId,
          startedAt,
        });
      }
      const reason = err instanceof Error ? err.message : String(err);
      return finish("failed", {
        sessionId: input.sessionId,
        startedAt,
        reason,
      });
    } finally {
      clearTimeout(timer);
      if (pending.get(input.sessionId) === controller) {
        pending.delete(input.sessionId);
      }
    }
  };

  return {
    async run(input) {
      try {
        return await runOne(input);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        deps.logger?.warn("voting.runner.failed", {
          sessionId: input.sessionId,
          tookMs: 0,
          reason,
        });
        return { outcome: "failed", applied: 0, rejected: 0 };
      }
    },
    abortPending(options) {
      if (options?.sessionId !== undefined) {
        const target = pending.get(options.sessionId);
        if (target) target.abort();
        return;
      }
      for (const controller of pending.values()) controller.abort();
    },
  };
}

function buildAllowlist(
  candidates: ReadonlyArray<VoteCandidate>,
): VoteAllowlist {
  const memory = new Set<number>();
  const lesson = new Set<number>();
  const profile = new Set<number>();
  for (const c of candidates) {
    switch (c.kind) {
      case "memory":
        memory.add(c.id);
        break;
      case "lesson":
        lesson.add(c.id);
        break;
      case "profile":
        profile.add(c.id);
        break;
    }
  }
  return { memory, lesson, profile };
}

interface ApplyContext {
  sessionId: string;
  turnIndex?: number;
  maxVotePerItem: number;
  eventLogMaxRows: number;
  metrics?: AgentMetrics;
  logger?: StructuredLogger;
  emitTrace?: (event: VoteTraceEvent) => void;
}

function safeEmit(
  emitTrace: ApplyContext["emitTrace"],
  event: VoteTraceEvent,
  logger: StructuredLogger | undefined,
): void {
  if (!emitTrace) return;
  try {
    emitTrace(event);
  } catch (err) {
    // A sink hiccup must never derail vote application — log + move on.
    logger?.warn("voting.trace.emit_failed", {
      sessionId: event.sessionId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

function applyVotes(
  votes: readonly ParsedVote[],
  parserRejections: readonly ParseRejection[],
  store: VoteStore,
  ctx: ApplyContext,
): { applied: number; rejected: number } {
  let applied = 0;
  let rejected = 0;
  // Pre-emit parser-level rejections so observability captures
  // every dropped line, not just the ones that reached the store.
  for (const r of parserRejections) {
    rejected += 1;
    ctx.metrics?.recordVotingRejected({
      sessionId: ctx.sessionId,
      reason: r.reason,
      kind: r.kind,
    });
    ctx.logger?.debug("voting.rejected", {
      sessionId: ctx.sessionId,
      reason: r.reason,
      kind: r.kind,
      targetId: r.targetId,
    });
    safeEmit(
      ctx.emitTrace,
      {
        type: "rejected",
        sessionId: ctx.sessionId,
        kind: r.kind ?? "unknown",
        targetId: r.targetId ?? null,
        // Parser-level rejections drop the line before the
        // direction is fully classified — `null` is the honest
        // value for trace consumers.
        direction: null,
        reason: r.reason,
      },
      ctx.logger,
    );
  }
  for (const v of votes) {
    try {
      const result = store.applyVote({
        kind: v.kind,
        targetId: v.targetId,
        direction: v.direction,
        maxVotePerItem: ctx.maxVotePerItem,
        sessionId: ctx.sessionId,
        ...(typeof ctx.turnIndex === "number"
          ? { turnIndex: ctx.turnIndex }
          : {}),
        eventLogMaxRows: ctx.eventLogMaxRows,
      });
      if (result.status === "applied") {
        applied += 1;
        ctx.metrics?.recordVotingApplied({
          sessionId: ctx.sessionId,
          kind: v.kind,
          direction: v.direction,
        });
        safeEmit(
          ctx.emitTrace,
          {
            type: "applied",
            sessionId: ctx.sessionId,
            kind: v.kind,
            targetId: v.targetId,
            direction: v.direction,
            score: result.newScore,
            clampHit: false,
          },
          ctx.logger,
        );
        continue;
      }
      rejected += 1;
      if (result.status === "clamp_hit") {
        ctx.metrics?.recordVotingRejected({
          sessionId: ctx.sessionId,
          reason: "clamp_hit",
          kind: v.kind,
        });
        ctx.logger?.debug("voting.rejected", {
          sessionId: ctx.sessionId,
          reason: "clamp_hit",
          kind: v.kind,
          targetId: v.targetId,
        });
        // clamp_hit is still informative: the operator's vote was
        // valid (it reached the store), the score just saturated.
        // Emit `applied` with `clampHit=true` so the trace reflects
        // the curation intent, not the no-op write outcome.
        safeEmit(
          ctx.emitTrace,
          {
            type: "applied",
            sessionId: ctx.sessionId,
            kind: v.kind,
            targetId: v.targetId,
            direction: v.direction,
            score: result.currentScore,
            clampHit: true,
          },
          ctx.logger,
        );
      } else if (result.status === "target_missing") {
        ctx.metrics?.recordVotingRejected({
          sessionId: ctx.sessionId,
          reason: "target_missing",
          kind: v.kind,
        });
        ctx.logger?.debug("voting.rejected", {
          sessionId: ctx.sessionId,
          reason: "target_missing",
          kind: v.kind,
          targetId: v.targetId,
        });
        safeEmit(
          ctx.emitTrace,
          {
            type: "rejected",
            sessionId: ctx.sessionId,
            kind: v.kind,
            targetId: v.targetId,
            direction: v.direction,
            reason: "target_missing",
          },
          ctx.logger,
        );
      }
    } catch (err) {
      if (err instanceof VoteValidationError) {
        rejected += 1;
        ctx.logger?.debug("voting.invalid_vote", {
          sessionId: ctx.sessionId,
          field: err.field,
          reason: err.message,
        });
        safeEmit(
          ctx.emitTrace,
          {
            type: "rejected",
            sessionId: ctx.sessionId,
            kind: v.kind,
            targetId: v.targetId,
            direction: v.direction,
            reason: "invalid_vote",
          },
          ctx.logger,
        );
        continue;
      }
      throw err;
    }
  }
  return { applied, rejected };
}
