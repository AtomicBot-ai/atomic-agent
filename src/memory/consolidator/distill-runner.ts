import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { MemoryEntry } from "../memory-store.js";
import type { ReflectionLlmComplete } from "../reflection/reflection-runner.js";

import { DISTILL_GRAMMAR } from "./distill-grammar.js";
import {
  DistillParseError,
  parseDistillOutput,
  type ParsedDistill,
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
export type DistillOutcome =
  | { kind: "ok"; lesson: Extract<ParsedDistill, { kind: "lesson" }> }
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
  metrics?: AgentMetrics;
  logger?: StructuredLogger;
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
    if (request.episodes.length === 0) {
      return { kind: "failed", reason: "empty_cluster" };
    }
    if (request.signal.aborted) {
      return { kind: "aborted" };
    }
    const prompt = buildDistillPrompt({
      episodes: request.episodes,
      sharedTags: request.sharedTags,
    });
    const innerCtrl = new AbortController();
    const onAbort = () => innerCtrl.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => innerCtrl.abort(), this.deps.timeoutMs);
    const startedAt = Date.now();
    try {
      const result = await this.deps.llmComplete({
        prompt,
        grammar: DISTILL_GRAMMAR,
        slotId: this.deps.slotId,
        sessionId: request.sessionId,
        signal: innerCtrl.signal,
      });
      const elapsed = Date.now() - startedAt;
      this.deps.metrics?.recordConsolidationDistillLatency(elapsed);
      const parsed = parseDistillOutput(result.content ?? "");
      if (parsed.kind === "none") {
        this.deps.logger?.info?.("consolidator.distill.none", {
          sessionId: request.sessionId,
          parentIds: request.episodes.map((e) => e.id),
        });
        return { kind: "none" };
      }
      this.deps.logger?.info?.("consolidator.distill.ok", {
        sessionId: request.sessionId,
        parentIds: request.episodes.map((e) => e.id),
        elapsedMs: elapsed,
      });
      return { kind: "ok", lesson: parsed };
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      this.deps.metrics?.recordConsolidationDistillLatency(elapsed);
      if (request.signal.aborted) {
        this.deps.logger?.warn?.("consolidator.distill.aborted", {
          sessionId: request.sessionId,
        });
        return { kind: "aborted" };
      }
      if (innerCtrl.signal.aborted) {
        this.deps.logger?.warn?.("consolidator.distill.timeout", {
          sessionId: request.sessionId,
          timeoutMs: this.deps.timeoutMs,
        });
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
      return { kind: "failed", reason };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    }
  }
}
