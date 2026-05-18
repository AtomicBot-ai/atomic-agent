import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { MemoryEntry } from "../memory-store.js";

import type { EmbeddingClient } from "./embedding-client.js";
import { EmbeddingUnavailableError } from "./embedding-client.js";
import type { EmbeddingStore } from "./embedding-store.js";

/**
 * Memory-v2 phase 1B. Brute-force JS cosine over `memory_embeddings`,
 * blended with the BM25 ranking returned by FTS5.
 *
 * Why brute force: `sqlite-vec` integration through `better-sqlite3`'s
 * extension loader is brittle across platforms (different .so / .dylib
 * names per arch, Apple Silicon notarisation, Windows .dll loaders).
 * For the v2 launch we accept O(N) cosine on the embedding rows — N
 * is bounded by `memory.notes.maxEntries` (default 1 000) and the
 * `bruteForceCeiling` soft-warn ensures we shout when corpus growth
 * outpaces the brute-force budget. A follow-up phase will graduate to
 * `sqlite-vec` or an ANN index without changing this module's API.
 *
 * Graceful degradation contract:
 *   - When `embeddingClient` is `null` (feature disabled, daemon down
 *     at construction time), `recallHybrid` simply returns the BM25
 *     hits passed in by the caller — no error, no metric noise.
 *   - When `embeddingClient.embed()` throws
 *     `EmbeddingUnavailableError`, the same fallback path fires and a
 *     single `agent.memory.embeddings.fallback_to_fts5` counter is
 *     emitted per turn so dashboards spot persistent daemon outages.
 *   - When the corpus exceeds `bruteForceCeiling`, the cosine path is
 *     **skipped** (not just slow) and the counter
 *     `agent.memory.embeddings.brute_force_overflow` increments. The
 *     caller still sees a useful FTS5-only result set.
 */

export interface HybridRecallInputEntry extends MemoryEntry {
  /** Lower is better — raw BM25 score as returned by `bm25(fts)`. */
  bm25Score: number;
}

export interface HybridRecallOptions {
  /** Top-K to return after blending. Capped by the caller. */
  k: number;
  /** Optional working-dir filter mirroring `MemoryRecallOptions.scope`. */
  workingDir?: string | null;
  /** Required tag set (AND semantics). Empty ⇒ no tag filter. */
  requiredTags?: readonly string[];
  /** Caller-supplied BM25 result set, pre-tag-filtered. */
  bm25Hits: HybridRecallInputEntry[];
  /** Free-form query text — used to compute the query embedding. */
  query: string;
  signal?: AbortSignal;
}

export interface HybridRecallDeps {
  embeddingClient: EmbeddingClient | null;
  embeddingStore: EmbeddingStore | null;
  /** Skip cosine when `memory_embeddings.model` row count exceeds this. */
  bruteForceCeiling: number;
  /** 0..1 weight for the normalised BM25 score. */
  fts5Weight: number;
  /** 0..1 weight for cosine similarity. `fts5Weight + vectorWeight` should equal 1. */
  vectorWeight: number;
  metrics?: AgentMetrics;
}

/**
 * Combine BM25 hits with cosine-ranked neighbours and return the
 * top-K blended set, deduplicated by `id`. Order of operations:
 *
 *  1. If `embeddingClient` or `embeddingStore` is null → return
 *     `bm25Hits.slice(0, k)` (graceful fallback).
 *  2. Embed the query (catch `EmbeddingUnavailableError`).
 *  3. Pull row count for the model. If `> bruteForceCeiling` → emit
 *     `brute_force_overflow` and return BM25-only.
 *  4. Otherwise: brute-force cosine over `listByModel`, apply
 *     workingDir + tags filters, blend with normalised BM25 scores,
 *     return top-K.
 */
export async function recallHybrid(
  deps: HybridRecallDeps,
  opts: HybridRecallOptions,
): Promise<MemoryEntry[]> {
  if (!deps.embeddingClient || !deps.embeddingStore) {
    return opts.bm25Hits.slice(0, opts.k);
  }

  let queryVec: Float32Array;
  try {
    const r = await deps.embeddingClient.embed({
      text: opts.query,
      signal: opts.signal,
    });
    queryVec = r.vector;
  } catch (err) {
    if (err instanceof EmbeddingUnavailableError) {
      deps.metrics?.recordMemoryEmbeddingsFallback({
        reason: "embed_failed",
      });
      return opts.bm25Hits.slice(0, opts.k);
    }
    throw err;
  }

  const model = deps.embeddingClient.model;
  const total = deps.embeddingStore.countByModel(model);
  if (total > deps.bruteForceCeiling) {
    deps.metrics?.recordMemoryEmbeddingsBruteForceOverflow({
      rows: total,
      ceiling: deps.bruteForceCeiling,
    });
    return opts.bm25Hits.slice(0, opts.k);
  }

  const candidates = deps.embeddingStore.listByModel(model);
  const requiredTags = opts.requiredTags ?? [];
  // Cosine over filtered candidates only.
  const cosineHits: Array<{ id: number; cosine: number }> = [];
  for (const c of candidates) {
    if (
      opts.workingDir !== undefined &&
      opts.workingDir !== null &&
      c.workingDir !== opts.workingDir
    ) {
      continue;
    }
    if (
      requiredTags.length > 0 &&
      !requiredTags.every((t) => c.tags.includes(t))
    ) {
      continue;
    }
    const cosine = cosineSimilarity(queryVec, c.vector);
    if (cosine > 0) cosineHits.push({ id: c.memoryId, cosine });
  }

  // Blend the two signals. BM25 is "lower is better" and unbounded
  // below; normalise via `1 / (1 + |bm25|)` so it maps to (0, 1].
  // Cosine is already in [-1, 1]; clamp to [0, 1] (negative cosine ⇒
  // unrelated, score 0).
  const blended = new Map<number, { entry: MemoryEntry; score: number }>();
  for (const hit of opts.bm25Hits) {
    const normBm25 = 1 / (1 + Math.abs(hit.bm25Score));
    blended.set(hit.id, {
      entry: hit,
      score: deps.fts5Weight * normBm25,
    });
  }
  for (const c of cosineHits) {
    const normCos = Math.max(0, Math.min(1, c.cosine));
    const existing = blended.get(c.id);
    if (existing) {
      existing.score += deps.vectorWeight * normCos;
    } else {
      // We need the full `MemoryEntry`. The caller's `bm25Hits` may
      // not contain this id (cosine-only neighbour). Read it from the
      // candidate metadata: we have id + workingDir + tags but not
      // content/createdAt/updatedAt — defer fetching via a callback
      // would be cleaner, but for now we skip cosine-only hits. The
      // BM25 hit-set already serves as the candidate pool; cosine
      // just re-ranks within it. Pure cosine-only recall is deferred
      // to a follow-up that lets the caller pass a hydrator.
      continue;
    }
  }
  return [...blended.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.k)
    .map((r) => r.entry);
}

/**
 * Cosine similarity. Both vectors must have the same length;
 * mismatched dims throw immediately to surface model-version drift
 * rather than silently returning zero (which would make every recall
 * look "unrelated").
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: dim mismatch ${a.length} vs ${b.length}`,
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
