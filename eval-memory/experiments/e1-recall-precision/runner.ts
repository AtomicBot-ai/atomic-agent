import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore, type MemoryEntry } from "../../../src/memory/memory-store.js";
import {
  EmbeddingStore,
  EmbeddingWriter,
  LlamaEmbeddingClient,
} from "../../../src/memory/embeddings/index.js";
import { LinkStore } from "../../../src/memory/links/link-store.js";

import { CORPUS_CLUSTERS, type CorpusCluster } from "./corpus.js";
import { E1_QUERIES, type E1Query, type QueryDifficulty } from "./queries.js";

/**
 * E1 runner — open `MemoryStore` (+ optional embeddings + links),
 * seed the labelled corpus, run every query in every requested mode,
 * compute P@5 / R@5 / MRR.
 *
 * All in-process. The only external dependency is the **embedding
 * daemon** (used only for the `hybrid` and `hybrid+links` modes). When
 * the daemon is unreachable those modes are skipped — the runner
 * still produces a complete BM25-only report.
 */

export type E1Mode = "bm25-only" | "hybrid" | "hybrid+links";

export interface E1RunnerOptions {
  /** Per-query top-K. Defaults to 5. */
  topK?: number;
  /** Modes to run. Defaults to all three. */
  modes?: readonly E1Mode[];
  /**
   * Required for `hybrid*` modes. URL of an embedding-only llama-server
   * (e.g. `http://127.0.0.1:18992`).
   *
   * When omitted, hybrid modes are skipped with a recorded reason.
   */
  embeddingUrl?: string;
  /**
   * Embedding model dim (must match the loaded model). When the model
   * is unknown ahead of time, `probeEmbeddingDaemon` from
   * `harness/llama-lifecycle.ts` plus a `/v1/models` call can populate
   * this; for v0 we accept it as an explicit input.
   */
  embeddingDim?: number;
  /** Embedding model id (recorded into `memory_embeddings.model`). */
  embeddingModel?: string;
  /** Injectable clock. Defaults to a monotonic per-store counter. */
  now?: () => number;
}

export interface E1QueryResult {
  queryId: string;
  clusterId: number;
  difficulty: QueryDifficulty;
  mode: E1Mode;
  hits: readonly number[]; // memory ids
  hitClusters: readonly number[]; // cluster ids per hit (same order)
  /** Precision@K — fraction of returned hits in the target cluster. */
  precision: number;
  /** Recall@K — fraction of target-cluster notes that appear in top-K. */
  recall: number;
  /** Reciprocal Rank — 0 when no hit is in the target cluster. */
  mrr: number;
}

export interface E1AggregateRow {
  mode: E1Mode;
  difficulty: QueryDifficulty | "all";
  queries: number;
  precisionMean: number;
  recallMean: number;
  mrrMean: number;
}

export interface E1Report {
  topK: number;
  modesRun: readonly E1Mode[];
  modesSkipped: ReadonlyArray<{ mode: E1Mode; reason: string }>;
  perQuery: readonly E1QueryResult[];
  aggregates: readonly E1AggregateRow[];
  /** Per-cluster size (used by recall normalisation). */
  clusterSizes: Readonly<Record<number, number>>;
}

const DEFAULT_TOP_K = 5;
const DEFAULT_MODES: readonly E1Mode[] = ["bm25-only", "hybrid", "hybrid+links"];

/**
 * The link seeder writes intra-cluster edges in pairs:
 * `(notes[0] <-> notes[1])`, `(notes[2] <-> notes[3])`, ...
 *
 * Pure intra-cluster by construction — so the link expansion can
 * only pull more correct results. The E1 expansion test is "does
 * the expansion plumbing work and not introduce false positives",
 * not "does the LLM-generated link graph contain only correct edges"
 * (that is E2/E3 territory).
 */
function seedLinks(linkStore: LinkStore, memoryIdsByCluster: Map<number, number[]>): void {
  for (const ids of memoryIdsByCluster.values()) {
    for (let i = 0; i + 1 < ids.length; i += 2) {
      const a = ids[i]!;
      const b = ids[i + 1]!;
      linkStore.add({ fromId: a, toId: b, kind: "RELATES_TO", weight: 1.0 });
      linkStore.add({ fromId: b, toId: a, kind: "RELATES_TO", weight: 1.0 });
    }
  }
}

interface SeededCorpus {
  /** Cluster id → memory ids seeded for that cluster. */
  memoryIdsByCluster: Map<number, number[]>;
  /** Reverse map: memory id → cluster id. */
  clusterByMemoryId: Map<number, number>;
}

function seedCorpus(store: MemoryStore, clusters: readonly CorpusCluster[]): SeededCorpus {
  const memoryIdsByCluster = new Map<number, number[]>();
  const clusterByMemoryId = new Map<number, number>();
  for (const cluster of clusters) {
    const ids: number[] = [];
    for (const note of cluster.notes) {
      const entry = store.store({
        content: note.content,
        tags: [...note.tags],
      });
      ids.push(entry.id);
      clusterByMemoryId.set(entry.id, cluster.id);
    }
    memoryIdsByCluster.set(cluster.id, ids);
  }
  return { memoryIdsByCluster, clusterByMemoryId };
}

function precisionAt(hitClusters: readonly number[], targetCluster: number): number {
  if (hitClusters.length === 0) return 0;
  let n = 0;
  for (const c of hitClusters) if (c === targetCluster) n += 1;
  return n / hitClusters.length;
}

function recallAt(
  hitClusters: readonly number[],
  targetCluster: number,
  clusterSize: number,
): number {
  if (clusterSize === 0) return 0;
  let n = 0;
  for (const c of hitClusters) if (c === targetCluster) n += 1;
  // Recall@K is capped at 1 even when K > clusterSize (it can't be).
  return Math.min(1, n / clusterSize);
}

function mrr(hitClusters: readonly number[], targetCluster: number): number {
  for (let i = 0; i < hitClusters.length; i += 1) {
    if (hitClusters[i] === targetCluster) return 1 / (i + 1);
  }
  return 0;
}

async function recallBm25(
  store: MemoryStore,
  query: string,
  topK: number,
): Promise<readonly MemoryEntry[]> {
  return store.recall(query, { k: topK });
}

async function recallHybrid(
  store: MemoryStore,
  query: string,
  topK: number,
): Promise<readonly MemoryEntry[]> {
  return store.recallHybridAsync(query, { k: topK });
}

/**
 * hybrid + 1-hop link expansion. Strategy:
 *
 *  1. Hybrid recall with k = ceil(topK / 2) so half the slots are
 *     reserved for graph-expanded neighbors.
 *  2. Expand seeds via `LinkStore.expand({ depth: 1, maxExpanded: topK })`.
 *  3. Concatenate `[...base, ...expansion]` (matches the production
 *     `memory-context-provider.ts` ordering — base hits come first).
 *  4. Slice to topK.
 *
 * Effectively benchmarks "can the graph fill in slots that hybrid
 * alone would have used on weaker matches?" — exactly the question
 * phase 2 is supposed to answer.
 */
async function recallHybridWithLinks(
  store: MemoryStore,
  linkStore: LinkStore,
  query: string,
  topK: number,
): Promise<readonly MemoryEntry[]> {
  const baseK = Math.max(1, Math.ceil(topK / 2));
  const base = await store.recallHybridAsync(query, { k: baseK });
  if (base.length === 0) return base;
  const expandedIds = linkStore.expand(
    base.map((e) => e.id),
    { depth: 1, maxExpanded: topK },
  );
  const seen = new Set<number>(base.map((e) => e.id));
  const merged: MemoryEntry[] = [...base];
  for (const id of expandedIds) {
    if (seen.has(id)) continue;
    const entry = store.get(id);
    if (!entry) continue;
    merged.push(entry);
    seen.add(id);
    if (merged.length >= topK) break;
  }
  return merged.slice(0, topK);
}

async function evaluateQuery(
  store: MemoryStore,
  linkStore: LinkStore,
  query: E1Query,
  mode: E1Mode,
  topK: number,
  clusterSizes: Readonly<Record<number, number>>,
  clusterByMemoryId: Map<number, number>,
): Promise<E1QueryResult> {
  let hits: readonly MemoryEntry[] = [];
  switch (mode) {
    case "bm25-only":
      hits = await recallBm25(store, query.query, topK);
      break;
    case "hybrid":
      hits = await recallHybrid(store, query.query, topK);
      break;
    case "hybrid+links":
      hits = await recallHybridWithLinks(store, linkStore, query.query, topK);
      break;
  }
  const hitIds = hits.map((h) => h.id);
  const hitClusters = hitIds.map((id) => clusterByMemoryId.get(id) ?? -1);
  return {
    queryId: query.id,
    clusterId: query.clusterId,
    difficulty: query.difficulty,
    mode,
    hits: hitIds,
    hitClusters,
    precision: precisionAt(hitClusters, query.clusterId),
    recall: recallAt(hitClusters, query.clusterId, clusterSizes[query.clusterId] ?? 0),
    mrr: mrr(hitClusters, query.clusterId),
  };
}

function aggregate(
  perQuery: readonly E1QueryResult[],
  modes: readonly E1Mode[],
): readonly E1AggregateRow[] {
  const rows: E1AggregateRow[] = [];
  const difficulties: ReadonlyArray<QueryDifficulty | "all"> = [
    "easy",
    "mid",
    "hard",
    "all",
  ];
  for (const mode of modes) {
    for (const difficulty of difficulties) {
      const sample = perQuery.filter(
        (r) => r.mode === mode && (difficulty === "all" || r.difficulty === difficulty),
      );
      if (sample.length === 0) continue;
      const precisionMean = sample.reduce((s, r) => s + r.precision, 0) / sample.length;
      const recallMean = sample.reduce((s, r) => s + r.recall, 0) / sample.length;
      const mrrMean = sample.reduce((s, r) => s + r.mrr, 0) / sample.length;
      rows.push({
        mode,
        difficulty,
        queries: sample.length,
        precisionMean,
        recallMean,
        mrrMean,
      });
    }
  }
  return rows;
}

/**
 * Synthesise the cluster-size lookup the recall normaliser needs.
 * In E1 every cluster has exactly 20 notes — but pulling the count
 * from the seeded data keeps the metric correct if a future caller
 * tweaks the corpus.
 */
function clusterSizesFromSeeded(clusters: readonly CorpusCluster[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const c of clusters) out[c.id] = c.notes.length;
  return out;
}

/**
 * Run E1 end-to-end. Pure function of options — no global state, no
 * env reads. Caller is responsible for emitting reports (see
 * `scripts/run-e1.mjs`).
 */
export async function runE1(opts: E1RunnerOptions = {}): Promise<E1Report> {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const requested = opts.modes ?? DEFAULT_MODES;
  const modesSkipped: Array<{ mode: E1Mode; reason: string }> = [];

  const tmp = mkdtempSync(join(tmpdir(), "atomic-eval-memory-e1-"));
  let nowCounter = 0;
  const now = opts.now ?? (() => ++nowCounter * 1000);

  const store = new MemoryStore({
    dbFile: join(tmp, "memory.sqlite"),
    maxEntries: CORPUS_CLUSTERS.reduce((s, c) => s + c.notes.length, 0) + 10,
    // Dedup off — corpus is hand-curated, we want every row in.
    dedup: { enabled: false, fts5Threshold: 0.95 },
    eviction: { utilityWeighted: false, maxAgeMs: Number.MAX_SAFE_INTEGER },
    now,
  });

  try {
    const seeded = seedCorpus(store, CORPUS_CLUSTERS);
    const clusterSizes = clusterSizesFromSeeded(CORPUS_CLUSTERS);

    // Always wire link store — it is cheap and `hybrid+links` mode
    // depends on it. With no edges added, expand() returns [].
    const linkStore = new LinkStore({
      db: store.getDatabaseHandleForEmbeddings(),
      now,
    });
    seedLinks(linkStore, seeded.memoryIdsByCluster);

    let canHybrid = false;
    if (requested.includes("hybrid") || requested.includes("hybrid+links")) {
      const reason = resolveHybridSkipReason(opts);
      if (reason) {
        for (const m of ["hybrid", "hybrid+links"] as const) {
          if (requested.includes(m)) modesSkipped.push({ mode: m, reason });
        }
      } else {
        const client = new LlamaEmbeddingClient({
          url: opts.embeddingUrl!,
          dim: opts.embeddingDim!,
          model: opts.embeddingModel ?? "unknown",
        });
        const embStore = new EmbeddingStore({
          db: store.getDatabaseHandleForEmbeddings(),
        });
        const writer = new EmbeddingWriter({ client, store: embStore });
        store.attachEmbeddings({ writer, store: embStore });
        // Backfill embeddings for everything we just seeded.
        const allIds = [...seeded.clusterByMemoryId.keys()];
        for (const id of allIds) {
          const entry = store.get(id);
          if (entry) await store.writeEmbeddingFor(id, entry.content);
        }
        canHybrid = true;
      }
    }

    const modesRun: E1Mode[] = [];
    for (const m of requested) {
      if (m === "bm25-only") {
        modesRun.push(m);
        continue;
      }
      if (canHybrid) modesRun.push(m);
    }

    const perQuery: E1QueryResult[] = [];
    for (const q of E1_QUERIES) {
      for (const mode of modesRun) {
        const result = await evaluateQuery(
          store,
          linkStore,
          q,
          mode,
          topK,
          clusterSizes,
          seeded.clusterByMemoryId,
        );
        perQuery.push(result);
      }
    }

    return {
      topK,
      modesRun,
      modesSkipped,
      perQuery,
      aggregates: aggregate(perQuery, modesRun),
      clusterSizes,
    };
  } finally {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

function resolveHybridSkipReason(opts: E1RunnerOptions): string | null {
  if (!opts.embeddingUrl) return "embeddingUrl not set";
  if (!opts.embeddingDim) return "embeddingDim not set";
  return null;
}
