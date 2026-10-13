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
 * is bounded by `memory.notes.maxEntries` (default 1 000) and the scan
 * by `bruteForceCeiling` (see `scanCandidates`), whose overflow counter
 * shouts when corpus growth outpaces the brute-force budget. A follow-up phase will graduate to
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
 *   - When the corpus exceeds `bruteForceCeiling`, the scan covers the
 *     newest `bruteForceCeiling` vectors plus the BM25 candidates'
 *     (keyword hits keep their re-rank, recent notes stay reachable by
 *     meaning) and `agent.memory.embeddings.brute_force_overflow`
 *     increments.
 *
 * Notes found only by meaning (no shared keyword, e.g. another
 * language) join the blend through `deps.hydrate` when they clear
 * `COSINE_ONLY_MIN_SIMILARITY`, at most `k` of them.
 */

/**
 * The cosine a note needs to be recalled on meaning alone. The embedding
 * models in the catalog (EmbeddingGemma, nomic) are normalised and put
 * unrelated short texts at roughly 0.1–0.3 and paraphrases or
 * translations well above 0.5; 0.35 keeps the first out without losing
 * the second. Keyword hits are not gated: BM25 already vouched for them.
 */
export const COSINE_ONLY_MIN_SIMILARITY = 0.35;

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
  /**
   * Most vectors one recall scans. Above it: the newest this many, plus
   * the BM25 candidates' vectors.
   */
  bruteForceCeiling: number;
  /** 0..1 weight for the normalised BM25 score. */
  fts5Weight: number;
  /** 0..1 weight for cosine similarity. `fts5Weight + vectorWeight` should equal 1. */
  vectorWeight: number;
  metrics?: AgentMetrics;
  /**
   * Loads the entries of notes found by cosine alone, by id (ids that no
   * longer exist are left out). Without it, cosine only re-ranks the BM25
   * hits.
   */
  hydrate?: (ids: readonly number[]) => MemoryEntry[];
}

/**
 * Combine BM25 hits with cosine-ranked neighbours and return the
 * top-K blended set, deduplicated by `id`. Order of operations:
 *
 *  1. If `embeddingClient` or `embeddingStore` is null → return
 *     `bm25Hits.slice(0, k)` (graceful fallback).
 *  2. Embed the query (catch `EmbeddingUnavailableError`).
 *  3. Read the candidate vectors (`scanCandidates`): all of the model's
 *     up to `bruteForceCeiling`, else the newest that many plus the BM25
 *     candidates', emitting `brute_force_overflow`.
 *  4. Cosine over them, apply workingDir + tags filters (the same ones
 *     the BM25 query applies), blend with normalised BM25 scores, add
 *     the best cosine-only notes above the floor, return top-K.
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
      purpose: "query",
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

  const candidates = scanCandidates(deps.embeddingStore, deps.embeddingClient.model, deps, opts);
  const requiredTags = opts.requiredTags ?? [];
  // Cosine over filtered candidates only. The filters mirror the BM25
  // query (`MemoryStore.recallRaw`): working dir in scope and every
  // required tag. It has no archived/kind filter, so neither does this.
  const cosineHits: Array<{ id: number; cosine: number }> = [];
  for (const c of candidates) {
    if (!passesFilters(c, opts.workingDir, requiredTags)) continue;
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
  const cosineOnly: Array<{ id: number; cosine: number }> = [];
  for (const c of cosineHits) {
    const normCos = Math.max(0, Math.min(1, c.cosine));
    const existing = blended.get(c.id);
    if (existing) existing.score += deps.vectorWeight * normCos;
    else if (c.cosine >= COSINE_ONLY_MIN_SIMILARITY) cosineOnly.push(c);
  }
  // Notes found by meaning alone: the best `k`, scored on cosine only
  // (their BM25 part is 0), so a keyword hit that also matches by
  // meaning still ranks above a meaning-only one of the same cosine.
  if (deps.hydrate && cosineOnly.length > 0) {
    cosineOnly.sort((a, b) => b.cosine - a.cosine);
    const top = cosineOnly.slice(0, opts.k);
    const cosineById = new Map(top.map((c) => [c.id, c.cosine]));
    for (const entry of deps.hydrate(top.map((c) => c.id))) {
      const cosine = cosineById.get(entry.id);
      // Re-checked on the hydrated row: it may have changed since the scan.
      if (cosine === undefined || !passesFilters(entry, opts.workingDir, requiredTags)) continue;
      blended.set(entry.id, { entry, score: deps.vectorWeight * Math.min(1, cosine) });
    }
  }
  return [...blended.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.k)
    .map((r) => r.entry);
}

type Candidate = ReturnType<EmbeddingStore["listByModel"]>[number];

/**
 * The vectors one recall scores. Up to `bruteForceCeiling` vectors for
 * the model: all of them. Above it: the newest `bruteForceCeiling` (recent
 * notes stay reachable by meaning) plus the BM25 candidates' (every
 * keyword hit keeps its re-rank), deduplicated. The cost is reading and
 * decoding the vectors (2 000 × 768 floats ≈ 6 MB) and as many dot
 * products: a few milliseconds per recall at the default ceiling.
 */
function scanCandidates(
  store: EmbeddingStore,
  model: string,
  deps: Pick<HybridRecallDeps, "bruteForceCeiling" | "metrics">,
  opts: Pick<HybridRecallOptions, "bm25Hits">,
): Candidate[] {
  const total = store.countByModel(model);
  if (total <= deps.bruteForceCeiling) return store.listByModel(model);
  deps.metrics?.recordMemoryEmbeddingsBruteForceOverflow({
    rows: total,
    ceiling: deps.bruteForceCeiling,
  });
  const byId = new Map<number, Candidate>();
  for (const c of store.listNewestByModel(model, deps.bruteForceCeiling)) byId.set(c.memoryId, c);
  const missing = opts.bm25Hits.map((hit) => hit.id).filter((id) => !byId.has(id));
  for (const c of store.listByModelForMemories(model, missing)) byId.set(c.memoryId, c);
  return [...byId.values()];
}

function passesFilters(
  row: { workingDir: string | null; tags: readonly string[] },
  workingDir: string | null | undefined,
  requiredTags: readonly string[],
): boolean {
  if (workingDir !== undefined && workingDir !== null && row.workingDir !== workingDir) return false;
  return requiredTags.every((t) => row.tags.includes(t));
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
