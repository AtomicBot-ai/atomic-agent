import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { MemoryEntry } from "../memory-store.js";
import type { ReflectionLlmComplete } from "../reflection/reflection-runner.js";

import {
  DISTILL_GRAMMAR,
  DISTILL_WITH_PROCEDURE_GRAMMAR,
} from "./distill-grammar.js";
import {
  DISTILL_RESPONSE_FORMAT,
  DISTILL_WITH_PROCEDURE_RESPONSE_FORMAT,
} from "./distill-response-format.js";
import {
  DistillParseError,
  parseDistillOutput,
  parseDistillWithProcedureOutput,
  type ParsedDistill,
  type ParsedProcedure,
} from "./distill-parser.js";
import { buildDistillPrompt } from "./distill-prompt.js";

/**
 * Memory-v2 phase 5. Result of a distill call for one cluster.
 *
 *  - `ok`       — parsed a real `LESSON`. The runner returns the
 *                 parsed shape; the `ConsolidatorJob` is responsible
 *                 for the actual `LessonStore.create` write.
 *  - `none`     — the model emitted the explicit abstain sentinel
 *                 (`(no consensus)` / `(no durable advice)`). The
 *                 cluster gets another shot on a future tick.
 *  - `aborted`  — the consolidator was cancelled mid-call.
 *  - `timeout`  — the LLM call exceeded `distillTimeoutMs`.
 *  - `failed`   — anything else (parse error, llama-server error,
 *                 GBNF rejection, …). One per-cluster failure does
 *                 **not** abort the tick — the tick continues with
 *                 the next cluster.
 */
/**
 * Memory-v2 phase 5/7b. Per-cluster trace event surfaced to the
 * cold-path consolidator trace bridge via the optional `emitTrace`
 * dep. Unlike the per-session sub-calls, the consolidator runs
 * out-of-band, so bootstrap emits this straight onto the `traceBus`
 * with the synthetic `consolidator` sessionId and the shared
 * cold-path `seq` counter. Fire-safe.
 */
export interface DistillTraceEvent {
  sessionId: string;
  outcome: "ok" | "none" | "aborted" | "timeout" | "failed";
  clusterSize?: number;
  hasProcedure?: boolean;
  reason?: string;
}

export type DistillOutcome =
  | {
      kind: "ok";
      lesson: Extract<ParsedDistill, { kind: "lesson" }>;
      /**
       * Memory-v2 phase 7b. Populated only when the runner was
       * configured with `withProcedure=true` and the model emitted
       * a valid `PROCEDURE` line. `null` for conceptually-related
       * but procedurally-divergent clusters (scenario 7b.B).
       */
      procedure: ParsedProcedure | null;
    }
  | { kind: "none" }
  | { kind: "aborted" }
  | { kind: "timeout" }
  | { kind: "failed"; reason: string };

export interface DistillRunnerDeps {
  llmComplete: ReflectionLlmComplete;
  /**
   * Dedicated reflection slot id (the same slot used by
   * `ReflectionRunner` and `LinkGenerator`). The distill call is
   * cold-path and infrequent so it is safe to share the reflection
   * slot — different reflection sub-calls already alternate on it.
   */
  slotId: number;
  /** Per-cluster wall-clock budget. */
  timeoutMs: number;
  /**
   * Memory-v2 phase 7b. When `true`, switch to the combined
   * `DISTILL_WITH_PROCEDURE_GRAMMAR`, append the procedure
   * doctrine to the prompt, and parse the response with
   * `parseDistillWithProcedureOutput`. The total number of LLM
   * calls **does not change** — invariant 21 (one inference per
   * cluster). Default `false` keeps phase 5/6 wire behaviour.
   */
  withProcedure?: boolean;
  metrics?: AgentMetrics;
  logger?: StructuredLogger;
  /**
   * Optional trace sink invoked once per `distill` call with the
   * canonical outcome. Bootstrap binds it to the consolidator trace
   * bridge (synthetic `consolidator` sessionId on the shared cold-path
   * `seq`). Fire-safe.
   */
  emitTrace?: (event: DistillTraceEvent) => void;
}

export interface DistillRequest {
  /** Used for trace correlation; the consolidator passes the host session id. */
  sessionId: string;
  episodes: readonly MemoryEntry[];
  sharedTags: readonly string[];
  signal: AbortSignal;
}

export class DistillRunner {
  constructor(private readonly deps: DistillRunnerDeps) {}

  async distill(request: DistillRequest): Promise<DistillOutcome> {
    const clusterSize = request.episodes.length;
    const emit = (
      outcome: DistillTraceEvent["outcome"],
      extra?: { hasProcedure?: boolean; reason?: string },
    ): void => {
      if (!this.deps.emitTrace) return;
      try {
        this.deps.emitTrace({
          sessionId: request.sessionId,
          outcome,
          clusterSize,
          ...(extra?.hasProcedure !== undefined
            ? { hasProcedure: extra.hasProcedure }
            : {}),
          ...(extra?.reason ? { reason: extra.reason } : {}),
        });
      } catch {
        // A sink hiccup must never derail the consolidator — swallow.
      }
    };
    if (clusterSize === 0) {
      emit("failed", { reason: "empty_cluster" });
      return { kind: "failed", reason: "empty_cluster" };
    }
    if (request.signal.aborted) {
      emit("aborted");
      return { kind: "aborted" };
    }
    const withProcedure = this.deps.withProcedure === true;
    const prompt = buildDistillPrompt({
      episodes: request.episodes,
      sharedTags: request.sharedTags,
      withProcedure,
    });
    const grammar = withProcedure
      ? DISTILL_WITH_PROCEDURE_GRAMMAR
      : DISTILL_GRAMMAR;
    const responseFormat = withProcedure
      ? DISTILL_WITH_PROCEDURE_RESPONSE_FORMAT
      : DISTILL_RESPONSE_FORMAT;
    const innerCtrl = new AbortController();
    const onAbort = () => innerCtrl.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => innerCtrl.abort(), this.deps.timeoutMs);
    const startedAt = Date.now();
    try {
      const result = await this.deps.llmComplete({
        prompt,
        grammar,
        responseFormat,
        slotId: this.deps.slotId,
        sessionId: request.sessionId,
        signal: innerCtrl.signal,
      });
      const elapsed = Date.now() - startedAt;
      this.deps.metrics?.recordConsolidationDistillLatency(elapsed);
      const rawContent = result.content ?? "";
      const parsed = withProcedure
        ? parseDistillWithProcedureOutput(rawContent)
        : parseDistillOutput(rawContent);
      if (parsed.kind === "none") {
        this.deps.logger?.info?.("consolidator.distill.none", {
          sessionId: request.sessionId,
          parentIds: request.episodes.map((e) => e.id),
        });
        emit("none");
        return { kind: "none" };
      }
      const procedure: ParsedProcedure | null =
        withProcedure && "procedure" in parsed
          ? ((parsed as { procedure: ParsedProcedure | null }).procedure ?? null)
          : null;
      this.deps.logger?.info?.("consolidator.distill.ok", {
        sessionId: request.sessionId,
        parentIds: request.episodes.map((e) => e.id),
        elapsedMs: elapsed,
        hasProcedure: procedure !== null,
      });
      emit("ok", { hasProcedure: procedure !== null });
      return {
        kind: "ok",
        lesson: {
          kind: "lesson",
          activation: parsed.activation,
          principle: parsed.principle,
          tags: parsed.tags,
        },
        procedure,
      };
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      this.deps.metrics?.recordConsolidationDistillLatency(elapsed);
      if (request.signal.aborted) {
        this.deps.logger?.warn?.("consolidator.distill.aborted", {
          sessionId: request.sessionId,
        });
        emit("aborted");
        return { kind: "aborted" };
      }
      if (innerCtrl.signal.aborted) {
        this.deps.logger?.warn?.("consolidator.distill.timeout", {
          sessionId: request.sessionId,
          timeoutMs: this.deps.timeoutMs,
        });
        emit("timeout");
        return { kind: "timeout" };
      }
      const reason =
        err instanceof DistillParseError
          ? `parse:${err.reason}`
          : err instanceof Error
            ? err.message
            : String(err);
      this.deps.logger?.warn?.("consolidator.distill.failed", {
        sessionId: request.sessionId,
        reason,
      });
      emit("failed", { reason });
      return { kind: "failed", reason };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    }
  }
}
