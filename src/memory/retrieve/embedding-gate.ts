import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { EmbeddingClient } from "../embeddings/embedding-client.js";
import { EmbeddingUnavailableError } from "../embeddings/embedding-client.js";
import { cosineSimilarity } from "../embeddings/hybrid-recall.js";

import type { RewriterGate } from "./rewriter-gate.js";

/**
 * Embedding-based rewriter gate (config v20).
 *
 * Lazy-warms unit-normalized exemplar vectors, then classifies each
 * message by max cosine similarity against the corpus. Fail-safe B:
 * any warm or per-call embedding failure → skip rewrite + log (same
 * as `skipped_not_referential` from the runner's perspective).
 */

export interface EmbeddingGateOptions {
  embedder: EmbeddingClient;
  exemplars: readonly string[];
  /** Cosine threshold in [0, 1]. Default 0.65. */
  threshold: number;
  warmTimeoutMs?: number;
  logger?: StructuredLogger;
  metrics?: AgentMetrics;
}

export function createEmbeddingGate(opts: EmbeddingGateOptions): RewriterGate {
  const threshold = opts.threshold;
  const warmTimeoutMs = opts.warmTimeoutMs ?? 8_000;
  const exemplars = opts.exemplars.filter((e) => e.trim().length > 0);

  let warmVectors: Float32Array[] | null = null;
  let warmPromise: Promise<Float32Array[] | null> | null = null;

  return {
    name: "embedding",
    async check({ message, historyTurnCount, signal }) {
      if (historyTurnCount <= 0) {
        recordSkip(opts, "no_history");
        return false;
      }
      const trimmed = message.trim();
      if (trimmed.length === 0) {
        recordSkip(opts, "empty_message");
        return false;
      }
      if (signal.aborted) {
        return false;
      }

      const vectors = await ensureWarm(opts, warmTimeoutMs, signal);
      if (!vectors || vectors.length === 0) {
        opts.logger?.warn?.("embedding_gate.unavailable", { phase: "warm" });
        recordSkip(opts, "unavailable");
        return false;
      }

      try {
        const { vector } = await opts.embedder.embed({
          text: trimmed,
          signal,
        });
        const unit = unitVector(vector);
        let maxScore = -1;
        for (const ref of vectors) {
          const score = cosineSimilarity(unit, ref);
          if (score > maxScore) maxScore = score;
        }
        opts.metrics?.recordRetrieveRewriterGateCosine?.({
          gateMode: "embedding",
          score: maxScore,
        });
        if (maxScore >= threshold) {
          opts.logger?.debug?.("embedding_gate.fired", {
            score: maxScore,
            threshold,
          });
          opts.metrics?.recordRetrieveRewriterGateFired?.({
            gateMode: "embedding",
          });
          return true;
        }
        opts.logger?.debug?.("embedding_gate.below_threshold", {
          score: maxScore,
          threshold,
        });
        recordSkip(opts, "below_threshold");
        return false;
      } catch (err) {
        if (signal.aborted) return false;
        const msg =
          err instanceof EmbeddingUnavailableError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        opts.logger?.warn?.("embedding_gate.unavailable", {
          phase: "embed",
          error: msg,
        });
        recordSkip(opts, "unavailable");
        return false;
      }
    },
  };

  async function ensureWarm(
    gateOpts: EmbeddingGateOptions,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Float32Array[] | null> {
    if (warmVectors) return warmVectors;
    if (!warmPromise) {
      warmPromise = warmExemplars(gateOpts, timeoutMs, signal).then((v) => {
        warmVectors = v;
        return v;
      });
    }
    return warmPromise;
  }

  async function warmExemplars(
    gateOpts: EmbeddingGateOptions,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Float32Array[] | null> {
    if (exemplars.length === 0) return null;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const results = await Promise.all(
        exemplars.map((text) =>
          gateOpts.embedder.embed({ text, signal: ac.signal }),
        ),
      );
      return results.map((r) => unitVector(r.vector));
    } catch (err) {
      if (signal.aborted) return null;
      const msg =
        err instanceof EmbeddingUnavailableError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      gateOpts.logger?.warn?.("embedding_gate.unavailable", {
        phase: "warm",
        error: msg,
      });
      return null;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function unitVector(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i += 1) norm += v[i]! * v[i]!;
  if (norm === 0) return v;
  const inv = 1 / Math.sqrt(norm);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = v[i]! * inv;
  return out;
}

function recordSkip(
  opts: EmbeddingGateOptions,
  reason: "below_threshold" | "no_history" | "unavailable" | "empty_message",
): void {
  opts.metrics?.recordRetrieveRewriterGateSkipped?.({
    gateMode: "embedding",
    reason,
  });
}
