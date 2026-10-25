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
 * language) come in through `deps.hydrate`, only into the slots keyword
 * hits leave free, and only when they clear the similarity floor and
 * stay close to the best cosine of the query (`admitsCosineOnly`).
 */

/**
 * Default cosine a note needs to be recalled on meaning alone, for
 * models without their own `minCosine` in the catalog. EmbeddingGemma
 * puts unrelated short texts at roughly 0.1–0.3 and paraphrases or
 * translations well above 0.5; 0.35 keeps the first out without losing
 * the second. Models whose unrelated texts score higher (nomic, BGE)
 * carry a higher floor in the catalog. Keyword hits are not gated: BM25
 * already vouched for them.
 */
export const COSINE_ONLY_MIN_SIMILARITY = 0.35;

/**
 * How far below the query's best cosine a meaning-only note may sit.
 * The prompt's auto-recall runs on every tool step: when nothing in the
 * corpus is really close, the floor alone would let the "least
 * unrelated" notes in each time. Anchoring to the best match keeps only
 * the notes that are about as close as the best one (0.15 is about the
 * gap between a paraphrase and a loosely related note on these models;
 * an estimate, not a measurement).
 */
export const COSINE_ONLY_MAX_GAP = 0.15;

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
   * The attached model's floor for meaning-only notes (catalog
   * `minCosine`). Default `COSINE_ONLY_MIN_SIMILARITY`.
   */
  minCosine?: number;
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
 *     the BM25 query applies). Keyword hits are ranked among themselves
 *     by normalised BM25 blended with cosine and keep their slots; the
 *     best meaning-only notes fill the slots left, return top-K.
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
  const cosineById = new Map<number, number>();
  for (const c of candidates) {
    if (!passesFilters(c, opts.workingDir, requiredTags)) continue;
    // A vector of another length (a corrupt or foreign row) cannot be
    // compared: skip it rather than fail the whole recall.
    if (c.vector.length !== queryVec.length) continue;
    cosineById.set(c.memoryId, cosineSimilarity(queryVec, c.vector));
  }

  // Keyword hits, re-ranked among themselves. FTS5's bm25() is negative
  // and more negative is better, so the strongest hit has the largest
  // magnitude: normalise by the set's largest so the best keyword hit
  // scores 1 (the old `1 / (1 + |bm25|)` gave it the smallest share).
  // Cosine is clamped to [0, 1] (negative ⇒ unrelated, 0).
  const maxBm25 = Math.max(0, ...opts.bm25Hits.map((hit) => Math.abs(hit.bm25Score)));
  const keyword = opts.bm25Hits
    .map((hit) => {
      const normBm25 = maxBm25 > 0 ? Math.abs(hit.bm25Score) / maxBm25 : 1;
      const cosine = Math.max(0, Math.min(1, cosineById.get(hit.id) ?? 0));
      return { entry: hit as MemoryEntry, score: deps.fts5Weight * normBm25 + deps.vectorWeight * cosine };
    })
    // Stable sort: equal scores keep BM25 order.
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.k)
    .map((r) => r.entry);

  // Notes found by meaning alone only fill the slots keyword hits leave
  // free: an exact keyword hit (an identifier, a path, a URL) is never
  // pushed out by something that merely sounds alike.
  const free = opts.k - keyword.length;
  if (free <= 0 || !deps.hydrate || deps.vectorWeight <= 0) return keyword;
  const keywordIds = new Set(opts.bm25Hits.map((hit) => hit.id));
  let bestCosine = 0;
  for (const cosine of cosineById.values()) if (cosine > bestCosine) bestCosine = cosine;
  const floor = Math.max(deps.minCosine ?? COSINE_ONLY_MIN_SIMILARITY, bestCosine - COSINE_ONLY_MAX_GAP);
  const meaningOnly = [...cosineById.entries()]
    .filter(([id, cosine]) => !keywordIds.has(id) && cosine >= floor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, free);
  if (meaningOnly.length === 0) return keyword;
  const hydrated = new Map(deps.hydrate(meaningOnly.map(([id]) => id)).map((entry) => [entry.id, entry]));
  const extra: MemoryEntry[] = [];
  for (const [id] of meaningOnly) {
    const entry = hydrated.get(id);
    // Re-checked on the hydrated row: it may have changed since the scan.
    if (entry && passesFilters(entry, opts.workingDir, requiredTags)) extra.push(entry);
  }
  return [...keyword, ...extra];
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
