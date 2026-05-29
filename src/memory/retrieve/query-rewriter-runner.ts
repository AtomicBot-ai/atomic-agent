import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

import { QUERY_REWRITER_GRAMMAR } from "./query-rewriter-grammar.js";
import { QUERY_REWRITER_RESPONSE_FORMAT } from "./query-rewriter-response-format.js";
import type { ResponseFormatJsonSchema } from "../../llm/provider/completion-types.js";
import {
  type RewriterHistoryTurn,
  buildRewriterPrompt,
} from "./query-rewriter-prompt.js";
import { parseRewriterOutput } from "./query-rewriter-parser.js";
import {
  createHeuristicGate,
  type RewriterGate,
} from "./rewriter-gate.js";

/**
 * v2.5 query rewriter (Phase A) — runner.
 *
 * Single entry point — `maybeRewrite` — that decides whether to fire
 * the LLM call based on the heuristic gate, and folds every failure
 * mode into "use the raw user message". The runner is fire-safe by
 * construction: it never throws, never blocks the recall path beyond
 * its hard `timeoutMs`, and never touches the main agent slot's or
 * the reflection slot's KV cache (it pins `slotId = -1`).
 *
 * Outcome taxonomy (mirrored in metrics):
 *   - `ok`                       — LLM produced a usable rewrite.
 *   - `skipped_not_referential`  — heuristic gate returned false.
 *   - `skipped_no_history`       — gate passed but history was empty.
 *   - `aborted`                  — caller's `AbortSignal` fired.
 *   - `timeout`                  — `timeoutMs` elapsed.
 *   - `failed`                   — LLM threw or parser rejected.
 */

export type RewriterOutcome =
  | "ok"
  | "skipped_not_referential"
  | "skipped_no_history"
  | "aborted"
  | "timeout"
  | "failed";

/**
 * Memory v2.5 phase A. Per-call trace event surfaced to the runtime's
 * per-session `TraceRecorder` via the optional `emitTrace` dep. The
 * bootstrap resolves the recorder by `sessionId`; a missing recorder
 * is a normal "tracing disabled" outcome, never an error.
 */
export interface QueryRewriterTraceEvent {
  sessionId: string;
  outcome: RewriterOutcome;
}

/**
 * Single completion call. Mirrors `ReflectionLlmComplete` shape so
 * bootstrap can construct one with the same underlying llama-server
 * client. **Must always be called with `slotId = -1`** — pinned by
 * the runner; tests assert it.
 */
export type RewriterLlmComplete = (params: {
  prompt: string;
  grammar: string;
  /**
   * Structured Outputs envelope for cloud providers — the cross-vendor
   * equivalent of GBNF. The bootstrap `llmComplete` forwards it under
   * `native_tools`; grammar-only providers (llama-server) ignore it.
   */
  responseFormat?: ResponseFormatJsonSchema;
  slotId: number;
  sessionId: string;
  signal: AbortSignal;
}) => Promise<CompletionResult>;

export interface QueryRewriterRunnerDeps {
  llmComplete: RewriterLlmComplete;
  /** Hard cap per call (ms). */
  timeoutMs: number;
  /** Referential gate. Defaults to {@link createHeuristicGate}. */
  gate?: RewriterGate;
  logger?: StructuredLogger;
  metrics?: AgentMetrics;
  /**
   * Optional trace sink invoked once per `maybeRewrite` call with the
   * canonical outcome. Bootstrap binds it to the per-session
   * `TraceRecorder.recordQueryRewriter`. Fire-safe.
   */
  emitTrace?: (event: QueryRewriterTraceEvent) => void;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface QueryRewriterRunner {
  /**
   * Returns the rewritten query when the heuristic + LLM agree that
   * a rewrite is useful. Otherwise returns the original `userMessage`
   * unchanged. Never throws.
   */
  maybeRewrite(input: {
    sessionId: string;
    userMessage: string;
    history: readonly RewriterHistoryTurn[];
    signal: AbortSignal;
  }): Promise<string>;
}

/** Slot affinity for the rewriter — always `-1` (no KV cache reuse). */
export const REWRITER_SLOT_ID = -1;

export function createQueryRewriterRunner(
  deps: QueryRewriterRunnerDeps,
): QueryRewriterRunner {
  const now = deps.now ?? (() => Date.now());
  const gate = deps.gate ?? createHeuristicGate();

  return {
    async maybeRewrite(input): Promise<string> {
      const startedAt = now();
      const raw = input.userMessage;

      if (input.history.length === 0) {
        record("skipped_no_history", startedAt, input.sessionId);
        return raw;
      }
      const referential = await gate.check({
        message: raw,
        historyTurnCount: input.history.length,
        signal: input.signal,
      });
      if (!referential) {
        record("skipped_not_referential", startedAt, input.sessionId);
        return raw;
      }

      // Abort fast-path so we do not even build the prompt when the
      // caller already cancelled.
      if (input.signal.aborted) {
        record("aborted", startedAt, input.sessionId);
        return raw;
      }

      const prompt = buildRewriterPrompt({
        history: input.history,
        currentMessage: raw,
      });

      // Race the completion against a hard timeout AND the caller's
      // abort signal. We do NOT reuse the caller's signal directly
      // because aborting it on timeout would also cancel sibling
      // operations on the same controller — we want the timeout to
      // be local to the rewriter.
      const ac = new AbortController();
      const onCallerAbort = () => ac.abort();
      input.signal.addEventListener("abort", onCallerAbort, { once: true });

      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new TimeoutMarker());
        }, deps.timeoutMs);
      });

      try {
        const completion = await Promise.race([
          deps.llmComplete({
            prompt,
            grammar: QUERY_REWRITER_GRAMMAR,
            responseFormat: QUERY_REWRITER_RESPONSE_FORMAT,
            slotId: REWRITER_SLOT_ID,
            sessionId: input.sessionId,
            signal: ac.signal,
          }),
          timeoutPromise,
        ]);
        const rewritten = parseRewriterOutput(completion.content);
        if (rewritten === null) {
          record("failed", startedAt, input.sessionId);
          return raw;
        }
        deps.logger?.debug?.("rewriter.ok", {
          sessionId: input.sessionId,
          originalLength: raw.length,
          rewrittenLength: rewritten.length,
        });
        record("ok", startedAt, input.sessionId);
        return rewritten;
      } catch (err) {
        if (err instanceof TimeoutMarker) {
          record("timeout", startedAt, input.sessionId);
          return raw;
        }
        if (input.signal.aborted) {
          record("aborted", startedAt, input.sessionId);
          return raw;
        }
        deps.logger?.warn?.("rewriter.failed", {
          sessionId: input.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        record("failed", startedAt, input.sessionId);
        return raw;
      } finally {
        if (timer) clearTimeout(timer);
        input.signal.removeEventListener("abort", onCallerAbort);
      }
    },
  };

  function record(
    outcome: RewriterOutcome,
    startedAt: number,
    sessionId: string,
  ): void {
    deps.metrics?.recordRetrieveRewriter?.({
      outcome,
      durationMs: now() - startedAt,
    });
    if (deps.emitTrace) {
      try {
        deps.emitTrace({ sessionId, outcome });
      } catch {
        // A sink hiccup must never derail recall — swallow.
      }
    }
  }
}

/**
 * Internal sentinel — distinguishes a timeout from a generic abort
 * inside the `Promise.race` so we can report the correct outcome.
 * Not exported; the only consumer is the catch block above.
 */
class TimeoutMarker extends Error {
  constructor() {
    super("query rewriter timed out");
    this.name = "TimeoutMarker";
  }
}
