import type { AgentMetrics } from "../../tracing/agent-metrics.js";

import type { EmbeddingClient } from "./embedding-client.js";
import { EmbeddingUnavailableError } from "./embedding-client.js";
import type { EmbeddingStore } from "./embedding-store.js";

/**
 * Memory-v2 phase 1B. Thin orchestrator: takes a freshly-inserted
 * memory id + the content, asks `EmbeddingClient` for a vector,
 * persists into `EmbeddingStore`.
 *
 * Failures are **always swallowed**. The agent loop's correctness
 * never depends on the embedding write succeeding — at worst the row
 * is invisible to hybrid recall (cosine path), still findable via
 * FTS5 BM25. Errors are folded into a metric counter so dashboards
 * spot persistent daemon outages without crashing the runtime.
 *
 * This module is the single writer for `memory_embeddings`; if you
 * find yourself calling `EmbeddingStore.upsert` directly from
 * elsewhere, route it through here so the metric/log contract stays
 * uniform.
 */
export type EmbeddingWriteOutcome = "stored" | "unavailable" | "failed";

export interface EmbeddingWriterDeps {
  client: EmbeddingClient;
  store: EmbeddingStore;
  metrics?: AgentMetrics;
  /** Defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
}

export class EmbeddingWriter {
  /**
   * Exposed read-only so `MemoryStore.recallHybridAsync` can reuse the
   * same client (and `model` / `dim`) without a separate dependency
   * injection. The setter exists only here in the constructor.
   */
  public readonly client: EmbeddingClient;
  private readonly store: EmbeddingStore;
  private readonly metrics: AgentMetrics | undefined;
  private readonly now: () => number;

  constructor(deps: EmbeddingWriterDeps) {
    this.client = deps.client;
    this.store = deps.store;
    this.metrics = deps.metrics;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Compute and persist an embedding for `(memoryId, content)`. Returns
   * `true` on success, `false` when the call gracefully degraded.
   * Never throws — see module doc.
   */
  async writeFor(memoryId: number, content: string): Promise<boolean> {
    return (await this.write(memoryId, content)) === "stored";
  }

  /**
   * `writeFor` that says why a write did not land: `unavailable` is the
   * client's typed transport error (the model is down or the request
   * was aborted), `failed` anything else. The backfill stops on either
   * instead of walking the rest of the corpus into the same error.
   * Never throws.
   */
  async write(
    memoryId: number,
    content: string,
    signal?: AbortSignal,
  ): Promise<EmbeddingWriteOutcome> {
    const started = this.now();
    try {
      const result = await this.client.embed({
        text: content,
        purpose: "document",
        ...(signal ? { signal } : {}),
      });
      this.store.upsert({
        memoryId,
        model: result.model,
        dim: this.client.dim,
        vector: result.vector,
        createdAt: this.now(),
      });
      this.metrics?.recordMemoryEmbeddingsGenerated({
        model: result.model,
        durationMs: this.now() - started,
      });
      return "stored";
    } catch (err) {
      // Both branches count as `embed_failed`; only the returned outcome
      // tells a daemon outage from a programmer error (a bug in
      // EmbeddingStore, a dimension mismatch).
      this.metrics?.recordMemoryEmbeddingsFallback({
        reason: "embed_failed",
      });
      return err instanceof EmbeddingUnavailableError ? "unavailable" : "failed";
    }
  }
}
