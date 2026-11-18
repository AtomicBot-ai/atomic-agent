import { EmbeddingUnavailableError, type EmbeddingClient } from "../../memory/embeddings/embedding-client.js";
import {
  COSINE_ONLY_MAX_GAP,
  COSINE_ONLY_MIN_SIMILARITY,
  cosineSimilarity,
} from "../../memory/embeddings/hybrid-recall.js";
import { searchTerms } from "../../session/session-search.js";
import { citeFor } from "./file-cite.js";
import type { ChunkMatch, ChunkRow, FileIndexStore } from "./file-index-store.js";
import type { FileSearchHit } from "./file-index-types.js";
import { applyRerank, type Reranker } from "./file-rerank.js";
import type { ChunkVector, FileVectorStore } from "./file-vector-store.js";

/**
 * Search the file index: FTS5 keywords always, cosine over chunk vectors
 * when memory embeddings are on. The blend is memory recall's, with the
 * same knobs (`memory/embeddings/hybrid-recall.ts`): keyword hits are
 * re-ranked by `fts5Weight` × normalised BM25 + `vectorWeight` × cosine
 * and keep their places; passages found by meaning alone only fill the
 * places left, above the same floor (`COSINE_ONLY_MIN_SIMILARITY`, or
 * the model's `minCosine`) and within `COSINE_ONLY_MAX_GAP` of the best
 * cosine. Without an embedding client, or when it does not answer, the
 * search is keyword-only.
 *
 * Candidates for the cosine come from `nearest` (the sqlite-vec mirror,
 * ATO-1052) when it answers, and from a bounded scan otherwise; both are
 * scored with the exact cosine of the stored vectors. A `reranker`, when
 * configured, re-orders a pool of up to {@link RERANK_POOL_MAX} hits by
 * their full chunk text and the best `topK` are kept; if it fails the
 * blended order stands.
 */
export interface FileSearchDeps {
  store: Pick<FileIndexStore, "matchChunks" | "chunksById">;
  vectors: Pick<FileVectorStore, "scan" | "countFor" | "byIds"> | null;
  /** Nearest chunk ids from a vector index, or `null` to scan. Asked only for whole-index searches. */
  nearest?: (model: string, query: Float32Array, k: number) => number[] | null;
  reranker?: Reranker | null;
  embedding: () => EmbeddingClient | null;
  fts5Weight: number;
  vectorWeight: number;
  minCosine?: number;
  /** Most vector candidates one search keeps (the closest; every stored vector is looked at). */
  scanLimit: number;
}

export interface FileSearchRequest {
  query: string;
  /** Real path of the folder to search under, or `null` for all. */
  under: string | null;
  topK: number;
  signal?: AbortSignal;
}

const SNIPPET_CHARS = 320;
/** Most hits one rerank call sees. */
export const RERANK_POOL_MAX = 40;
/** Vector-index candidates asked for per wanted hit (at least {@link NEAREST_MIN}). */
const NEAREST_PER_HIT = 10;
const NEAREST_MIN = 200;

interface RankedHit {
  chunkId: number;
  hit: FileSearchHit;
}

export async function searchFileIndex(deps: FileSearchDeps, request: FileSearchRequest): Promise<FileSearchHit[]> {
  const reranker = deps.reranker ?? null;
  const pool = reranker === null ? request.topK : Math.max(request.topK, Math.min(request.topK * 2, RERANK_POOL_MAX));
  const ranked = await blendedHits(deps, { ...request, topK: pool });
  if (reranker === null) return ranked.slice(0, request.topK).map((r) => r.hit);
  const rows = new Map(deps.store.chunksById(ranked.map((r) => r.chunkId)).map((row) => [row.chunkId, row.text]));
  const texts = ranked.map((r) => cleanSnippet(rows.get(r.chunkId) ?? r.hit.snippet));
  const reordered = await applyRerank(reranker, request.query, ranked, texts, request.signal);
  return reordered.slice(0, request.topK).map(({ item, score }) => (score === null ? item.hit : { ...item.hit, score }));
}

async function blendedHits(deps: FileSearchDeps, request: FileSearchRequest): Promise<RankedHit[]> {
  const scan = Math.max(request.topK * 4, 20);
  const keyword = keywordMatches(deps.store, request.query, request.under, scan);
  const keywordOnly = () => keyword.slice(0, request.topK).map((match, i) => keywordHit(match, keyword.length - i));
  const client = deps.embedding();
  if (client === null || deps.vectors === null || deps.vectorWeight <= 0 || deps.vectors.countFor(client.model) === 0) {
    return keywordOnly();
  }
  let queryVector: Float32Array;
  try {
    queryVector = (await client.embed({ text: request.query, purpose: "query", ...(request.signal ? { signal: request.signal } : {}) })).vector;
  } catch (error) {
    if (!(error instanceof EmbeddingUnavailableError)) throw error;
    return keywordOnly();
  }
  const cosine = new Map<number, number>();
  const keywordIds = keyword.map((m) => m.chunkId);
  for (const candidate of candidates(deps, deps.vectors, client.model, queryVector, request, keywordIds)) {
    if (candidate.vector.length !== queryVector.length) continue;
    cosine.set(candidate.chunkId, cosineSimilarity(queryVector, candidate.vector));
  }
  const maxBm25 = Math.max(0, ...keyword.map((m) => Math.abs(m.bm25)));
  const ranked = keyword
    .map((match) => {
      const norm = maxBm25 > 0 ? Math.abs(match.bm25) / maxBm25 : 1;
      const cos = Math.max(0, Math.min(1, cosine.get(match.chunkId) ?? 0));
      return { match, score: deps.fts5Weight * norm + deps.vectorWeight * cos };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, request.topK);
  const hits = ranked.map(({ match, score }) => keywordHit(match, score));
  const free = request.topK - hits.length;
  if (free <= 0) return hits;
  const inKeyword = new Set(keywordIds);
  let best = 0;
  for (const value of cosine.values()) if (value > best) best = value;
  const floor = Math.max(deps.minCosine ?? COSINE_ONLY_MIN_SIMILARITY, best - COSINE_ONLY_MAX_GAP);
  const meaningOnly = [...cosine.entries()]
    .filter(([id, value]) => !inKeyword.has(id) && value >= floor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, free);
  const rows = new Map(deps.store.chunksById(meaningOnly.map(([id]) => id)).map((row) => [row.chunkId, row]));
  for (const [id, value] of meaningOnly) {
    const row = rows.get(id);
    if (row !== undefined) hits.push(meaningHit(row, deps.vectorWeight * value));
  }
  return hits;
}

/**
 * Vectors to score: the vector index's nearest plus the keyword hits when
 * it answers (whole-index searches only: it cannot filter by folder),
 * else a scan of every stored vector keeping the closest `scanLimit`,
 * plus the keyword hits.
 */
function candidates(
  deps: FileSearchDeps,
  vectors: NonNullable<FileSearchDeps["vectors"]>,
  model: string,
  query: Float32Array,
  request: FileSearchRequest,
  keywordIds: readonly number[],
): ChunkVector[] {
  if (request.under === null && deps.nearest) {
    const ids = deps.nearest(model, query, Math.max(request.topK * NEAREST_PER_HIT, NEAREST_MIN));
    if (ids !== null) return vectors.byIds(model, [...ids, ...keywordIds]);
  }
  return vectors.scan(model, request.under, deps.scanLimit, keywordIds, query);
}

/** Every term first; when that finds nothing, any of them (as session search does). */
function keywordMatches(store: FileSearchDeps["store"], query: string, under: string | null, limit: number): ChunkMatch[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const all = store.matchChunks(terms.join(" AND "), under, limit);
  if (all.length > 0 || terms.length === 1) return all;
  return store.matchChunks(terms.join(" OR "), under, limit);
}

function keywordHit(match: ChunkMatch, score: number): RankedHit {
  return { chunkId: match.chunkId, hit: hit(match.path, match.page, match.timeSec, cleanSnippet(match.snippet), score) };
}

function meaningHit(row: ChunkRow, score: number): RankedHit {
  const text = cleanSnippet(row.text);
  const snippet = text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS)}…` : text;
  return { chunkId: row.chunkId, hit: hit(row.path, row.page, row.timeSec, snippet, score) };
}

function hit(path: string, page: number | null, timeSec: number | null, snippet: string, score: number): FileSearchHit {
  const target = {
    path,
    ...(page !== null ? { page } : {}),
    ...(page === null && timeSec !== null ? { timeSec } : {}),
  };
  return { ...target, snippet, score, cite: citeFor(target) };
}

function cleanSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
