import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentMetrics } from "../tracing/agent-metrics.js";

import { applyMigrations } from "./memory-schema.js";
import type { EmbeddingStore } from "./embeddings/embedding-store.js";
import type { EmbeddingWriter } from "./embeddings/embedding-writer.js";
import {
  recallHybrid,
  type HybridRecallDeps,
  type HybridRecallInputEntry,
} from "./embeddings/hybrid-recall.js";

export type MemorySource = "agent" | "user";

export interface MemoryEntry {
  id: number;
  content: string;
  createdAt: number;
  updatedAt: number;
  source: MemorySource;
  sessionId: string | null;
  workingDir: string | null;
  tags: string[];
  /**
   * Memory-v2 phase 1A. Bumped exactly once per turn by `recall()` so
   * utility-weighted eviction can prefer "old but useful" rows over
   * "old and never-recalled" ones. Defaults to `0` for fresh rows and
   * any row migrated from a v3 database.
   */
  recallCount: number;
  /**
   * Memory-v2 phase 1A. Wall-clock ms of the most recent successful
   * recall. `null` for rows that have never been recalled (e.g. fresh
   * inserts) and for every row migrated from v3.
   */
  lastRecalledAt: number | null;
}

export interface MemoryStoreOptions {
  dbFile: string;
  /** Hard cap on `memories` rows. When exceeded, oldest by `updated_at` are evicted. */
  maxEntries: number;
  /**
   * Memory-v2 phase 1A. Pre-insert near-match deduplication via an
   * FTS5 candidate query followed by Jaccard token-overlap similarity
   * in JS. When omitted, dedup is **disabled** so existing callers
   * (including the test suite) keep their pre-v2 behaviour
   * verbatim. Bootstrap wires production runs from
   * `config.memory.dedup`.
   */
  dedup?: {
    enabled: boolean;
    /** Jaccard similarity threshold in `[0, 1]`. Higher = stricter merge rule. */
    fts5Threshold: number;
  };
  /**
   * Memory-v2 phase 1A. Overflow eviction strategy. Omitted ⇒ legacy
   * FIFO-by-`updated_at` (back-compat). `utilityWeighted=true` switches
   * to `recall_count ASC, COALESCE(last_recalled_at, 0) ASC, updated_at ASC`
   * so frequently-recalled rows survive overflow. `maxAgeMs` is plumbed
   * through for phase 5's consolidator sweep — phase 1A does not
   * consult it.
   */
  eviction?: {
    utilityWeighted: boolean;
    maxAgeMs: number;
  };
  /**
   * Optional metrics sink. When provided, dedup decisions, eviction
   * sweeps, and clock-skew detections are reported through this
   * interface. Omitted in tests so no implicit wiring is forced.
   */
  metrics?: AgentMetrics;
  /**
   * Injectable clock for deterministic tests. Defaults to `Date.now`.
   * The `now` callback is also consulted by `recall()` for
   * `last_recalled_at` updates — wire it consistently with `store()`
   * if tests assert temporal ordering.
   */
  now?: () => number;
  /**
   * Memory-v2 phase 1B. Optional embedding plumbing. When all three
   * are provided AND the daemon is reachable, `store()` will write a
   * vector to `memory_embeddings` and `recallAsync()` blends BM25
   * with cosine via `HybridRecall`. Any of these missing ⇒ FTS5-only
   * recall (graceful fallback).
   *
   * `embeddingStore` is opened by the caller against the **same**
   * SQLite handle as `MemoryStore` so the cascade `ON DELETE CASCADE`
   * from `memories(id)` fires automatically on memory removal. The
   * `MemoryStore` exposes its handle via `getDatabaseHandleForEmbeddings()`
   * for bootstrap; tests typically open it themselves.
   */
  embeddings?: {
    writer: EmbeddingWriter;
    store: EmbeddingStore;
    /** 0..1 weight for normalised BM25. Defaults to 0.5. */
    fts5Weight?: number;
    /** 0..1 weight for cosine. Defaults to 0.5. */
    vectorWeight?: number;
    /** Brute-force cosine ceiling. Default 200 — matches MEMORY_FABRIC_V2.md §13.7.1. */
    bruteForceCeiling?: number;
  };
}

export interface MemoryStoreInput {
  content: string;
  tags?: string[];
  sessionId?: string | null;
  workingDir?: string | null;
  source?: MemorySource;
}

export interface MemoryRecallOptions {
  k?: number;
  scope?: "project" | "all";
  workingDir?: string | null;
  tags?: string[];
}

export interface MemoryListOptions {
  scope?: "project" | "all";
  workingDir?: string | null;
  limit?: number;
}

/**
 * Compact pointer row returned by `listIndex`. Carries just enough
 * information for the prompt's `### memory-index` section (id + first
 * line / preview + tags) so the agent can decide whether to fetch the
 * full entry via `memory.notes.recall { id }`. The preview is the
 * first non-empty line trimmed to `previewChars`; callers never see
 * the full content through this method.
 */
export interface MemoryIndexEntry {
  id: number;
  preview: string;
  tags: string[];
  updatedAt: number;
  workingDir: string | null;
  sessionId: string | null;
}

export interface MemoryIndexOptions extends MemoryListOptions {
  /** Max preview length (first non-empty line, clipped). */
  previewChars?: number;
}

/**
 * Memory-v2 phase 3. Outcome of `MemoryStore.evolveTags`.
 *
 *  - `applied`             — the tag set actually grew. `tags` is the
 *                            final (merged) tag list; `added` is the
 *                            subset that was new.
 *  - `skipped_lease_held`  — `consolidating_at` is set and the lease
 *                            window has not yet expired. The
 *                            consolidator owns this row right now;
 *                            try again next turn.
 *  - `skipped_no_change`   — every proposed tag was already present.
 *                            `tags` echoes the existing set so callers
 *                            can log diagnostics without an extra
 *                            read.
 *  - `missing`             — the target id no longer exists (e.g.
 *                            evicted between the surface and the
 *                            evolve call).
 */
export type EvolveTagsResult =
  | { outcome: "applied"; tags: readonly string[]; added: readonly string[] }
  | { outcome: "skipped_lease_held" }
  | { outcome: "skipped_no_change"; tags: readonly string[] }
  | { outcome: "missing" };

/** Hard ceiling on a single stored content value to keep the FTS index sane. */
export const MEMORY_CONTENT_MAX_LENGTH = 4_000;
/** Hard ceiling on a single tag string. */
export const MEMORY_TAG_MAX_LENGTH = 40;
/** Hard ceiling on the number of tags per entry. */
export const MEMORY_MAX_TAGS = 16;
/** Hard ceiling on a recall query string. */
export const MEMORY_QUERY_MAX_LENGTH = 500;
/** Default number of results for recall when `k` is not specified. */
export const MEMORY_RECALL_DEFAULT_K = 5;
/** Cap on `k` to protect the prompt budget. */
export const MEMORY_RECALL_MAX_K = 50;
/** Cap on `list.limit` to protect the prompt budget. */
export const MEMORY_LIST_MAX_LIMIT = 200;
/** Default preview length for `listIndex` rows. */
export const MEMORY_INDEX_PREVIEW_CHARS_DEFAULT = 80;
/** Hard ceiling on preview length, irrespective of caller request. */
export const MEMORY_INDEX_PREVIEW_CHARS_MAX = 400;

interface MemoryRow {
  id: number;
  content: string;
  created_at: number;
  updated_at: number;
  source: string;
  session_id: string | null;
  working_dir: string | null;
  tags: string | null;
  recall_count: number;
  last_recalled_at: number | null;
}

/**
 * Durable freeform memory with FTS5 keyword search. Unlike `ProfileStore`
 * (key/value facts auto-rendered into every prompt), `MemoryStore`
 * entries are only surfaced when the agent explicitly calls
 * `memory.notes.recall`. Entries are ranked by BM25; no prompt contact
 * happens implicitly, so adding a memory never invalidates the stable
 * prefix KV cache.
 *
 * All methods are synchronous because volume is bounded by `maxEntries`
 * (default ~1000) and `better-sqlite3` is already synchronous.
 *
 * TODO(memory-v2): cross-phase invariant 3 — `MemoryEntry.content` is
 * append-only across the whole v2 rollout. Phase 3's `neighbor-evolver`
 * may mutate `tags` and `context` only; no caller may issue
 * `UPDATE memories SET content = ?` outside the FTS5 trigger plumbing.
 * Pinned by `neighbor-evolver.test.ts`. See [MEMORY_FABRIC_V2.md](../../MEMORY_FABRIC_V2.md) §9 invariant 5.
 *
 * TODO(memory-v2): cross-phase invariant 5 — every periodic bulk
 * operation (decay, eviction, archival, rewire, dedup-merge) must be a
 * single SQL statement. No per-row JS loop with I/O (§13.7.6). Pinned by
 * a 5000-row statement-count ceiling test.
 *
 * TODO(memory-v2): cross-phase invariant 7 — every temporal score in
 * recall/eviction/decay must clamp `(now - ts) < 0` to the safe end and
 * emit `agent.memory.clock_skew_detected` (§13.7.2 / invariant 15).
 */
export class MemoryStore {
  private readonly db: Database.Database;
  private readonly maxEntries: number;
  private readonly dedupEnabled: boolean;
  private readonly dedupThreshold: number;
  private readonly evictionUtilityWeighted: boolean;
  private readonly metrics: AgentMetrics | undefined;
  private embeddingWriter: EmbeddingWriter | undefined;
  private embeddingStore: EmbeddingStore | undefined;
  private readonly embeddingFts5Weight: number;
  private readonly embeddingVectorWeight: number;
  private readonly embeddingBruteForceCeiling: number;
  private readonly now: () => number;
  private readonly insertStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly evictFifoStmt: Database.Statement;
  private readonly evictUtilityStmt: Database.Statement;
  private readonly touchOnDedupStmt: Database.Statement;
  private readonly recallTouchStmt: Database.Statement;
  private readonly dedupCandidateStmt: Database.Statement;

  constructor(options: MemoryStoreOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new Error(
        `MemoryStore: maxEntries must be a positive integer, got ${options.maxEntries}`,
      );
    }
    const dedupThreshold = options.dedup?.fts5Threshold ?? 0.85;
    if (
      !Number.isFinite(dedupThreshold) ||
      dedupThreshold < 0 ||
      dedupThreshold > 1
    ) {
      throw new Error(
        `MemoryStore: dedup.fts5Threshold must be in [0, 1], got ${dedupThreshold}`,
      );
    }
    mkdirSync(dirname(options.dbFile), { recursive: true });
    this.db = new DatabaseCtor(options.dbFile);
    this.db.pragma("journal_mode = WAL");
    // Memory-v2 phase 1B: enable foreign-key enforcement so
    // `memory_embeddings.memory_id REFERENCES memories(id) ON DELETE
    // CASCADE` actually fires on `MemoryStore.remove`. SQLite disables
    // FK enforcement per-connection by default; turning it on here is
    // safe for v3/v4 databases too — no existing schema relied on
    // dangling FKs.
    this.db.pragma("foreign_keys = ON");
    applyMigrations(this.db);
    this.maxEntries = options.maxEntries;
    this.dedupEnabled = options.dedup?.enabled ?? false;
    this.dedupThreshold = dedupThreshold;
    this.evictionUtilityWeighted = options.eviction?.utilityWeighted ?? false;
    // `options.eviction.maxAgeMs` is plumbed through the config but
    // not consumed in phase 1A — the consolidator sweep (phase 5)
    // reads it from `config.memory.eviction.maxAgeMs` directly. Until
    // then the field stays out of `MemoryStore` so TypeScript does not
    // flag dead state.
    this.metrics = options.metrics;
    this.embeddingWriter = options.embeddings?.writer;
    this.embeddingStore = options.embeddings?.store;
    this.embeddingFts5Weight = options.embeddings?.fts5Weight ?? 0.5;
    this.embeddingVectorWeight = options.embeddings?.vectorWeight ?? 0.5;
    this.embeddingBruteForceCeiling =
      options.embeddings?.bruteForceCeiling ?? 200;
    this.now = options.now ?? Date.now;
    this.insertStmt = this.db.prepare(
      `INSERT INTO memories
         (content, created_at, updated_at, source, session_id, working_dir, tags,
          recall_count, last_recalled_at, consolidating_at)
       VALUES
         (@content, @created_at, @updated_at, @source, @session_id, @working_dir, @tags,
          0, NULL, NULL)`,
    );
    this.deleteStmt = this.db.prepare(`DELETE FROM memories WHERE id = ?`);
    this.getStmt = this.db.prepare(
      `SELECT id, content, created_at, updated_at, source, session_id, working_dir, tags,
              recall_count, last_recalled_at
         FROM memories WHERE id = ?`,
    );
    this.countStmt = this.db.prepare(`SELECT COUNT(*) AS count FROM memories`);
    // Legacy FIFO eviction (back-compat: omit eviction options ⇒ same as v1).
    this.evictFifoStmt = this.db.prepare(
      `DELETE FROM memories WHERE id IN (
         SELECT id FROM memories ORDER BY updated_at ASC, id ASC LIMIT ?
       )`,
    );
    // Utility-weighted eviction. Single SQL statement — cross-phase
    // invariant 5: no per-row JS loop with I/O (§13.7.6).
    this.evictUtilityStmt = this.db.prepare(
      `DELETE FROM memories WHERE id IN (
         SELECT id FROM memories
          ORDER BY recall_count ASC,
                   COALESCE(last_recalled_at, 0) ASC,
                   updated_at ASC,
                   id ASC
          LIMIT ?
       )`,
    );
    // On a dedup-merge: existing row absorbs the new write. `updated_at`
    // is touched so it floats to the top of `list()`; tags are merged
    // (new ∪ existing) so the absorbed entry's tag superset is preserved.
    this.touchOnDedupStmt = this.db.prepare(
      `UPDATE memories
          SET updated_at = @updated_at,
              tags = @tags,
              recall_count = recall_count + 1
        WHERE id = @id`,
    );
    // Single SQL statement bumps `recall_count` and stamps
    // `last_recalled_at` for every row in the recall result set.
    // Cross-phase invariant 5.
    this.recallTouchStmt = this.db.prepare(
      `UPDATE memories
          SET recall_count = recall_count + 1,
              last_recalled_at = @now
        WHERE id = @id`,
    );
    // FTS5 candidate fetch for dedup. Returns the top 5 BM25 hits so
    // Jaccard similarity can be computed in JS over a small candidate
    // set without paying the cost of a full scan.
    this.dedupCandidateStmt = this.db.prepare(
      `SELECT m.id, m.content, m.tags, bm25(memories_fts) AS score
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.rowid
        WHERE memories_fts MATCH ?
        ORDER BY score ASC
        LIMIT 5`,
    );
  }

  /**
   * Persist a new freeform memory.
   *
   * Memory-v2 phase 1A: when `dedup.enabled` was passed to the
   * constructor, this method first queries FTS5 for up to 5 candidate
   * neighbours and computes Jaccard similarity over normalised content
   * tokens in JS. If the best score clears `dedup.fts5Threshold` and
   * the candidate's tag set is a superset of the new entry's, the
   * existing row absorbs the write (touch `updated_at`, bump
   * `recall_count`, merge tags as new ∪ existing) and `store` returns
   * that existing row instead of inserting. This is the load-bearing
   * guard against a chatty reflection flooding the corpus with
   * paraphrases of the same observation.
   *
   * After a new INSERT, evicts overflow rows. The eviction predicate
   * depends on `eviction.utilityWeighted`:
   *   - `false` (back-compat): oldest by `updated_at` first.
   *   - `true`: 3-tier priority `recall_count ASC,
   *     COALESCE(last_recalled_at, 0) ASC, updated_at ASC` so old but
   *     frequently-recalled rows survive.
   */
  store(input: MemoryStoreInput, now: number = this.now()): MemoryEntry {
    const content = validateContent(input.content);
    const tags = validateTags(input.tags);
    const source = validateSource(input.source ?? "agent");
    const sessionId = validateOptionalString(input.sessionId, "sessionId");
    const workingDir = validateOptionalString(input.workingDir, "workingDir");

    if (this.dedupEnabled) {
      const merged = this.tryDedupMerge({ content, tags, now });
      if (merged !== null) return merged;
    } else {
      this.metrics?.recordMemoryDedup({
        outcome: "disabled",
        bestScore: 0,
        candidateId: null,
      });
    }

    const tagsJson = tags.length > 0 ? JSON.stringify(tags) : null;
    const result = this.insertStmt.run({
      content,
      created_at: now,
      updated_at: now,
      source,
      session_id: sessionId,
      working_dir: workingDir,
      tags: tagsJson,
    }) as { lastInsertRowid: number | bigint };
    const id = Number(result.lastInsertRowid);
    this.evictOverflow();

    // Memory-v2 phase 1B. Fire-and-forget embedding write. We do NOT
    // await this in the synchronous `store()` path so existing
    // callers (`memory.notes.store` tool handler, `reflection-runner`)
    // keep their current latency profile. `EmbeddingWriter.writeFor`
    // is itself error-swallowing — failures land in a metric counter,
    // never as a thrown error. Tests that need to assert the
    // embedding is on disk before continuing should call
    // `storeAsync()` instead, which awaits the write.
    if (this.embeddingWriter) {
      void this.embeddingWriter.writeFor(id, content);
    }

    return {
      id,
      content,
      createdAt: now,
      updatedAt: now,
      source,
      sessionId,
      workingDir,
      tags,
      recallCount: 0,
      lastRecalledAt: null,
    };
  }

  /**
   * Memory-v2 phase 1B. Async sibling of `store()` that awaits the
   * embedding write before returning. Used by tests and any future
   * caller that wants the just-inserted row to be hybrid-recallable
   * on the very next turn — without this guarantee, there is a
   * (small) race between insert and embed during a fast back-to-back
   * `store ⇒ recall` sequence.
   *
   * Identical semantics to `store()` when embeddings are not attached.
   */
  async storeAsync(
    input: MemoryStoreInput,
    now: number = this.now(),
  ): Promise<MemoryEntry> {
    const entry = this.store(input, now);
    if (this.embeddingWriter) {
      // `store()` already kicked off a fire-and-forget. We could
      // dedup but the embedding daemon is the bottleneck — a second
      // call is cheap relative to the model inference. Simpler to
      // re-call and let `UPSERT` handle it.
      await this.embeddingWriter.writeFor(entry.id, entry.content);
    }
    return entry;
  }

  /**
   * Pre-insert dedup pipeline. Returns the absorbed row when a merge
   * happened, `null` when no candidate cleared the bar. Always emits
   * exactly one `MemoryDedup` metric sample so the outcome ratio is
   * trustworthy. Single FTS5 query + JS-side similarity — no per-row
   * I/O (cross-phase invariant 5 still holds because the candidate
   * set is at most 5 rows fetched in one statement).
   */
  private tryDedupMerge(args: {
    content: string;
    tags: string[];
    now: number;
  }): MemoryEntry | null {
    const ftsQuery = buildFtsQuery(args.content);
    if (ftsQuery.length === 0) {
      this.metrics?.recordMemoryDedup({
        outcome: "skipped",
        bestScore: 0,
        candidateId: null,
      });
      return null;
    }
    const tokens = tokeniseForSimilarity(args.content);
    if (tokens.size === 0) {
      this.metrics?.recordMemoryDedup({
        outcome: "skipped",
        bestScore: 0,
        candidateId: null,
      });
      return null;
    }
    type CandidateRow = {
      id: number;
      content: string;
      tags: string | null;
      score: number;
    };
    let candidates: CandidateRow[];
    try {
      candidates = this.dedupCandidateStmt.all(ftsQuery) as CandidateRow[];
    } catch {
      // Malformed FTS query degrades to "no candidates"; the write
      // proceeds as a fresh INSERT rather than failing the call.
      this.metrics?.recordMemoryDedup({
        outcome: "skipped",
        bestScore: 0,
        candidateId: null,
      });
      return null;
    }

    let best: { id: number; score: number; row: CandidateRow } | null = null;
    for (const row of candidates) {
      const score = jaccardSimilarity(
        tokens,
        tokeniseForSimilarity(row.content),
      );
      if (best === null || score > best.score) {
        best = { id: row.id, score, row };
      }
    }

    if (best === null) {
      this.metrics?.recordMemoryDedup({
        outcome: "skipped",
        bestScore: 0,
        candidateId: null,
      });
      return null;
    }
    if (best.score < this.dedupThreshold) {
      this.metrics?.recordMemoryDedup({
        outcome: "skipped",
        bestScore: best.score,
        candidateId: best.id,
      });
      return null;
    }
    const existingTags = parseTags(best.row.tags);
    // Tag-superset rule: existing.tags ⊇ new.tags. Same-set is OK
    // (trivial superset); strict mismatch ⇒ skip the merge so a
    // re-tagging never silently collapses topics.
    if (!isTagSuperset(existingTags, args.tags)) {
      this.metrics?.recordMemoryDedup({
        outcome: "skipped",
        bestScore: best.score,
        candidateId: best.id,
      });
      return null;
    }

    // Merge tags = existing ∪ new, dedup preserved, ordering by first
    // appearance in existing then new. Storage-side this writes JSON.
    const mergedTags = mergeTagSets(existingTags, args.tags);
    const mergedTagsJson =
      mergedTags.length > 0 ? JSON.stringify(mergedTags) : null;
    this.touchOnDedupStmt.run({
      id: best.id,
      updated_at: args.now,
      tags: mergedTagsJson,
    });
    this.metrics?.recordMemoryDedup({
      outcome: "merged",
      bestScore: best.score,
      candidateId: best.id,
    });
    const refreshed = this.get(best.id);
    if (refreshed !== null) return refreshed;
    // Defensive: existing row evaporated between merge and re-fetch
    // (concurrent writer?). Fall back to "no merge" so the caller still
    // sees their content land somewhere.
    return null;
  }

  /**
   * BM25-ranked keyword search over `memories_fts`. Returns at most `k`
   * entries (default `MEMORY_RECALL_DEFAULT_K`, hard-capped by
   * `MEMORY_RECALL_MAX_K`). `scope: "project"` restricts to rows whose
   * `working_dir` matches `opts.workingDir`; the caller is responsible
   * for passing the current working directory when they want that
   * filter.
   *
   * When `tags` is given, every requested tag must be present in the
   * row's tag set (AND semantics). Empty / whitespace-only query
   * returns an empty array without a database round-trip.
   */
  recall(query: string, opts: MemoryRecallOptions = {}): MemoryEntry[] {
    const normalizedQuery = validateQuery(query);
    const ftsQuery = buildFtsQuery(normalizedQuery);
    if (ftsQuery.length === 0) return [];
    const k = clampPositiveInt(
      opts.k ?? MEMORY_RECALL_DEFAULT_K,
      1,
      MEMORY_RECALL_MAX_K,
      "k",
    );
    const scope = opts.scope ?? "all";
    const requiredTags = validateTags(opts.tags);
    const where: string[] = [`memories_fts MATCH ?`];
    const params: unknown[] = [ftsQuery];
    if (scope === "project") {
      const dir = validateOptionalString(opts.workingDir, "workingDir");
      if (dir === null) return [];
      where.push(`m.working_dir = ?`);
      params.push(dir);
    }
    const sql = `
      SELECT m.id, m.content, m.created_at, m.updated_at,
             m.source, m.session_id, m.working_dir, m.tags,
             m.recall_count, m.last_recalled_at
        FROM memories_fts
        JOIN memories m ON m.id = memories_fts.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY bm25(memories_fts) ASC
       LIMIT ?`;
    params.push(k * (requiredTags.length > 0 ? 4 : 1));
    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    const mapped = rows.map(rowToEntry);
    const filtered =
      requiredTags.length === 0
        ? mapped
        : mapped.filter((e) => requiredTags.every((t) => e.tags.includes(t)));
    const sliced = filtered.slice(0, k);
    if (sliced.length > 0) this.touchOnRecall(sliced);
    return sliced;
  }

  /**
   * Memory-v2 phase 1A: bump `recall_count` + stamp `last_recalled_at`
   * on every row returned by the most recent `recall()` call. Wrapped
   * in a transaction so all touches commit together; the in-memory
   * entries returned to the caller are also refreshed so downstream
   * consumers see the new values without an extra round-trip.
   *
   * Clock-skew safety (cross-phase invariant 7): `last_recalled_at`
   * is set to `now`. If a stored `created_at` is somehow ahead of
   * `now` (DB clock drift, manual migration), the metric
   * `agent.memory.clock_skew_detected` is incremented with
   * `site=memory_store_recall` and the row is still touched — we
   * prefer "row stays alive" to "row mysteriously skipped".
   */
  private touchOnRecall(entries: MemoryEntry[]): void {
    if (entries.length === 0) return;
    const now = this.now();
    const skewed: MemoryEntry[] = [];
    for (const e of entries) {
      const delta = now - e.createdAt;
      if (delta < 0) skewed.push(e);
    }
    if (skewed.length > 0 && this.metrics) {
      // Emit one detection per skewed row so dashboards can spot
      // wholesale clock jumps vs. isolated outliers.
      for (const e of skewed) {
        this.metrics.recordMemoryClockSkew({
          site: "memory_store_recall",
          deltaMs: now - e.createdAt,
        });
      }
    }
    const tx = this.db.transaction((rows: MemoryEntry[]) => {
      for (const row of rows) {
        this.recallTouchStmt.run({ id: row.id, now });
      }
    });
    tx(entries);
    for (const e of entries) {
      // Mutate in place so callers see the updated counters. The fields
      // were declared on `MemoryEntry` in v2 phase 1A — this is the
      // sole writer of the in-memory copy.
      (e as { recallCount: number }).recallCount = e.recallCount + 1;
      (e as { lastRecalledAt: number | null }).lastRecalledAt = now;
    }
  }

  get(id: number): MemoryEntry | null {
    const normalizedId = validateId(id);
    const row = this.getStmt.get(normalizedId) as MemoryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  remove(id: number): boolean {
    const normalizedId = validateId(id);
    const result = this.deleteStmt.run(normalizedId) as { changes: number };
    return result.changes > 0;
  }

  /**
   * Return entries ordered by `updated_at DESC`. `scope: "project"`
   * filters by `working_dir`. `limit` defaults to 50 and is hard-capped
   * by `MEMORY_LIST_MAX_LIMIT`.
   */
  list(opts: MemoryListOptions = {}): MemoryEntry[] {
    const limit = clampPositiveInt(
      opts.limit ?? 50,
      1,
      MEMORY_LIST_MAX_LIMIT,
      "limit",
    );
    const scope = opts.scope ?? "all";
    const where: string[] = [];
    const params: unknown[] = [];
    if (scope === "project") {
      const dir = validateOptionalString(opts.workingDir, "workingDir");
      if (dir === null) return [];
      where.push(`working_dir = ?`);
      params.push(dir);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `
      SELECT id, content, created_at, updated_at,
             source, session_id, working_dir, tags,
             recall_count, last_recalled_at
        FROM memories
        ${whereClause}
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(rowToEntry);
  }

  /**
   * Compact pointer view over recent notes. Returns one row per entry
   * in `updated_at DESC` order, stripped down to the minimum fields
   * needed for the prompt's `### memory-index` section. Kept cheap
   * enough to call on every turn — no FTS round-trip, just a sorted
   * scan over `memories`.
   *
   * The preview is derived from `renderNotePreview` so tests share the
   * same trimming rules with the prompt renderer.
   */
  listIndex(opts: MemoryIndexOptions = {}): MemoryIndexEntry[] {
    const entries = this.list(opts);
    const previewChars = clampPreviewChars(opts.previewChars);
    return entries.map((e) => ({
      id: e.id,
      preview: renderNotePreview(e.content, previewChars),
      tags: e.tags,
      updatedAt: e.updatedAt,
      workingDir: e.workingDir,
      sessionId: e.sessionId,
    }));
  }

  /** Total number of stored entries. Useful for tests and diagnostics. */
  count(): number {
    const row = this.countStmt.get() as { count: number };
    return row.count;
  }

  /**
   * Memory-v2 phase 3. Read the lease column directly without
   * loading the full row. Used by tests and the consolidator path.
   */
  getConsolidatingAt(id: number): number | null {
    const normalizedId = validateId(id);
    const row = this.db
      .prepare(`SELECT consolidating_at FROM memories WHERE id = ?`)
      .get(normalizedId) as { consolidating_at: number | null } | undefined;
    return row ? row.consolidating_at : null;
  }

  /**
   * Memory-v2 phase 3. Stamp the B↔C lease on a memory row. Used by
   * phase 5's `ConsolidatorJob` to claim a cluster before clustering.
   * Returns `true` when the stamp landed (the row exists and the
   * previous lease was either NULL or expired). Returns `false` when
   * the row is missing OR another fresh lease is in flight.
   *
   * The check + write is one SQL statement so two consolidator workers
   * cannot both acquire the same row. The reflection-side
   * `neighbor-evolver` does not call this — it only **reads** the
   * lease via `evolveTags` to skip rows under consolidation.
   */
  acquireConsolidationLease(
    id: number,
    leaseMs: number,
    now: number = this.now(),
  ): boolean {
    const normalizedId = validateId(id);
    const threshold = now - Math.max(0, leaseMs);
    const r = this.db
      .prepare(
        `UPDATE memories
            SET consolidating_at = ?
          WHERE id = ?
            AND (consolidating_at IS NULL OR consolidating_at <= ?)`,
      )
      .run(now, normalizedId, threshold) as { changes: number };
    return r.changes > 0;
  }

  /**
   * Memory-v2 phase 3. Release the B↔C lease (used after the
   * consolidator finishes its sweep, or in tests).
   */
  releaseConsolidationLease(id: number): boolean {
    const normalizedId = validateId(id);
    const r = this.db
      .prepare(
        `UPDATE memories SET consolidating_at = NULL WHERE id = ?`,
      )
      .run(normalizedId) as { changes: number };
    return r.changes > 0;
  }

  /**
   * Memory-v2 phase 3. Metadata-only refinement of a memory's tag
   * set. **Content is never touched** — neither the SQL nor the
   * caller interface accepts a content delta, which keeps the
   * append-only contract on `MemoryEntry.content` defended at the
   * store level (cross-phase invariant 5 in MEMORY_FABRIC_V2.md
   * §13.7.7).
   *
   * Semantics:
   *  - `addTags` is merge-only. Duplicates collapse; existing tags are
   *    preserved verbatim. Tag order is `[...existing, ...new-only]`.
   *  - The lease is honoured: when `consolidating_at` is set and the
   *    elapsed window since then is `<= leaseMs`, the call returns
   *    `{ outcome: "skipped_lease_held" }` without mutating the row.
   *    This is the B↔C race guard.
   *  - The lease is **not** acquired by this call — only checked.
   *  - When the resulting tag set is identical to the existing one
   *    (e.g. the LLM proposed tags already present), the call returns
   *    `{ outcome: "skipped_no_change" }` and does not bump
   *    `updated_at` — this preserves the FIFO ordering for
   *    legacy-eviction callers that have not flipped to
   *    `utilityWeighted`.
   *  - Missing target returns `{ outcome: "missing" }`.
   *  - Validation errors (empty `addTags`, invalid tag tokens) throw
   *    `MemoryValidationError` — same surface as `store()`.
   *
   * The `now` parameter is exposed for tests; production callers pass
   * the runner's injected clock.
   */
  evolveTags(
    id: number,
    addTags: readonly string[],
    opts: { leaseMs: number; now?: number } = { leaseMs: 0 },
  ): EvolveTagsResult {
    const normalizedId = validateId(id);
    const cleanTags = normalizeTagsInput(addTags);
    if (cleanTags.length === 0) {
      throw new MemoryValidationError(
        "tags",
        "evolveTags requires at least one valid tag",
      );
    }
    const now = opts.now ?? this.now();
    const row = this.db
      .prepare(
        `SELECT tags, consolidating_at FROM memories WHERE id = ?`,
      )
      .get(normalizedId) as
      | { tags: string | null; consolidating_at: number | null }
      | undefined;
    if (!row) return { outcome: "missing" };
    if (row.consolidating_at !== null) {
      const elapsed = now - row.consolidating_at;
      if (elapsed >= 0 && elapsed <= Math.max(0, opts.leaseMs)) {
        return { outcome: "skipped_lease_held" };
      }
    }
    const existing = parseTags(row.tags);
    const merged = applyEvolveTags(existing, cleanTags);
    if (merged.addedTags.length === 0) {
      return {
        outcome: "skipped_no_change",
        tags: existing,
      };
    }
    const nextTagsJson = JSON.stringify(merged.tags);
    this.db
      .prepare(
        `UPDATE memories
            SET tags = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(nextTagsJson, now, normalizedId);
    return {
      outcome: "applied",
      tags: merged.tags,
      added: merged.addedTags,
    };
  }

  /**
   * Memory-v2 phase 3. Validation surface for the
   * `MemoryValidationError.field` discriminant. Exposed mainly to
   * keep the `addTags` field name visible in stack traces from the
   * `evolveTags` path — the error itself is still constructed with
   * the canonical `tags` literal so existing handlers do not break.
   */
  close(): void {
    this.db.close();
  }

  /**
   * Memory-v2 phase 1B. Returns the live `better-sqlite3` handle so
   * bootstrap can construct an `EmbeddingStore` against the **same**
   * connection (FK cascade depends on it). Intentionally not narrowed
   * to a subset interface — callers should pass the result straight
   * through to `new EmbeddingStore({ db })`.
   *
   * Do not stash a reference outside the runtime: the handle's
   * lifetime is owned by `MemoryStore` and dies with `close()`.
   */
  getDatabaseHandleForEmbeddings(): import("better-sqlite3").Database {
    return this.db as unknown as import("better-sqlite3").Database;
  }

  /**
   * Memory-v2 phase 1B. Late binding for the embedding plumbing.
   * Bootstrap opens the `MemoryStore` first (which owns the SQLite
   * handle and runs migrations), then — once the embedding daemon's
   * health is confirmed — constructs `EmbeddingStore` + `Writer`
   * against the **same** handle and calls this. This avoids a chicken-
   * and-egg dependency where the store would need to be re-created
   * just to add the embedding side.
   *
   * Idempotent: re-attaching after a daemon hot-swap (e.g. operator
   * runs `models stop && models start` with a different embedding
   * model) simply replaces the writer/store.
   */
  attachEmbeddings(args: {
    writer: EmbeddingWriter;
    store: EmbeddingStore;
  }): void {
    this.embeddingWriter = args.writer;
    this.embeddingStore = args.store;
  }

  detachEmbeddings(): void {
    this.embeddingWriter = undefined;
    this.embeddingStore = undefined;
  }

  /**
   * Memory-v2 phase 1B. Fire-and-forget embedding write. Idempotent:
   * the underlying `UPSERT` handles re-embeds when the model is
   * upgraded. Always non-throwing — see `EmbeddingWriter` doc.
   *
   * Public so the bootstrap-time backfill path (re-embed legacy v3
   * rows) can iterate the corpus without going through `store()`.
   */
  async writeEmbeddingFor(memoryId: number, content: string): Promise<boolean> {
    if (!this.embeddingWriter) return false;
    return this.embeddingWriter.writeFor(memoryId, content);
  }

  /**
   * Memory-v2 phase 1B. Hybrid recall: BM25 + cosine blend. When
   * embeddings are not wired (no client / no store / disabled), this
   * is observably identical to `recall(query, opts)` — same hits,
   * same order, same `recall_count` bump.
   *
   * Async because the embedding client makes an HTTP round-trip.
   * Callers that cannot await (legacy synchronous paths) should keep
   * calling `recall()` directly — they will simply miss the cosine
   * re-ranking.
   */
  async recallHybridAsync(
    query: string,
    opts: MemoryRecallOptions = {},
  ): Promise<MemoryEntry[]> {
    const normalizedQuery = validateQuery(query);
    const ftsQuery = buildFtsQuery(normalizedQuery);
    if (ftsQuery.length === 0) return [];
    const k = clampPositiveInt(
      opts.k ?? MEMORY_RECALL_DEFAULT_K,
      1,
      MEMORY_RECALL_MAX_K,
      "k",
    );
    const scope = opts.scope ?? "all";
    const requiredTags = validateTags(opts.tags);
    let workingDir: string | null | undefined;
    if (scope === "project") {
      const dir = validateOptionalString(opts.workingDir, "workingDir");
      if (dir === null) return [];
      workingDir = dir;
    }

    const bm25Hits = this.recallRaw(
      ftsQuery,
      workingDir ?? null,
      requiredTags,
      k * 4,
    );
    if (!this.embeddingWriter || !this.embeddingStore) {
      // No hybrid wiring — return BM25 top-K and bump recall_count
      // the same way `recall()` does.
      const sliced = bm25Hits.slice(0, k);
      if (sliced.length > 0) this.touchOnRecall(sliced);
      return sliced;
    }
    const deps: HybridRecallDeps = {
      embeddingClient: this.embeddingWriter.client,
      embeddingStore: this.embeddingStore,
      bruteForceCeiling: this.embeddingBruteForceCeiling,
      fts5Weight: this.embeddingFts5Weight,
      vectorWeight: this.embeddingVectorWeight,
      ...(this.metrics ? { metrics: this.metrics } : {}),
    };
    const blended = await recallHybrid(deps, {
      k,
      bm25Hits,
      query: normalizedQuery,
      ...(workingDir !== undefined ? { workingDir } : {}),
      requiredTags,
    });
    if (blended.length > 0) this.touchOnRecall(blended);
    return blended;
  }

  /**
   * Internal BM25-only fetch used by both `recall` and
   * `recallHybridAsync`. Returns the raw `bm25Score` alongside the
   * `MemoryEntry` so the hybrid layer can blend without a second
   * round-trip. No `recall_count` touch here — callers do that after
   * the final slice is selected.
   */
  private recallRaw(
    ftsQuery: string,
    workingDir: string | null,
    requiredTags: readonly string[],
    limit: number,
  ): HybridRecallInputEntry[] {
    const where: string[] = [`memories_fts MATCH ?`];
    const params: unknown[] = [ftsQuery];
    if (workingDir !== null) {
      where.push(`m.working_dir = ?`);
      params.push(workingDir);
    }
    const sql = `
      SELECT m.id, m.content, m.created_at, m.updated_at,
             m.source, m.session_id, m.working_dir, m.tags,
             m.recall_count, m.last_recalled_at,
             bm25(memories_fts) AS bm25
        FROM memories_fts
        JOIN memories m ON m.id = memories_fts.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY bm25 ASC
       LIMIT ?`;
    params.push(limit);
    type RawRow = MemoryRow & { bm25: number };
    const rows = this.db.prepare(sql).all(...params) as RawRow[];
    const filtered =
      requiredTags.length === 0
        ? rows
        : rows.filter((r) =>
            requiredTags.every((t) => parseTags(r.tags).includes(t)),
          );
    return filtered.map((r) => ({
      ...rowToEntry(r),
      bm25Score: r.bm25,
    }));
  }

  private evictOverflow(): void {
    const current = this.count();
    if (current <= this.maxEntries) return;
    const excess = current - this.maxEntries;
    const stmt = this.evictionUtilityWeighted
      ? this.evictUtilityStmt
      : this.evictFifoStmt;
    const result = stmt.run(excess) as { changes: number };
    this.metrics?.recordMemoryEviction({
      reason: "overflow",
      evicted: result.changes,
      utilityWeighted: this.evictionUtilityWeighted,
    });
  }
}

export class MemoryValidationError extends Error {
  constructor(
    public readonly field: "content" | "tags" | "query" | "id" | "source" | "sessionId" | "workingDir" | "k" | "limit",
    message: string,
  ) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

function validateContent(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new MemoryValidationError(
      "content",
      "memory content must be a string",
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new MemoryValidationError(
      "content",
      "memory content must be non-empty",
    );
  }
  if (trimmed.length > MEMORY_CONTENT_MAX_LENGTH) {
    throw new MemoryValidationError(
      "content",
      `memory content must be at most ${MEMORY_CONTENT_MAX_LENGTH} chars`,
    );
  }
  return trimmed;
}

function validateTags(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new MemoryValidationError("tags", "tags must be a string array");
  }
  if (raw.length > MEMORY_MAX_TAGS) {
    throw new MemoryValidationError(
      "tags",
      `tags must contain at most ${MEMORY_MAX_TAGS} entries`,
    );
  }
  const normalized: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      throw new MemoryValidationError(
        "tags",
        `tags[${i}] must be a string`,
      );
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      throw new MemoryValidationError(
        "tags",
        `tags[${i}] must be non-empty`,
      );
    }
    if (trimmed.length > MEMORY_TAG_MAX_LENGTH) {
      throw new MemoryValidationError(
        "tags",
        `tags[${i}] must be at most ${MEMORY_TAG_MAX_LENGTH} chars`,
      );
    }
    if (!normalized.includes(trimmed)) normalized.push(trimmed);
  }
  return normalized;
}

/**
 * Memory-v2 phase 3. Normalise a tag-input array for `evolveTags`.
 * Reuses `validateTags` semantics (trim, length cap, max-count) but
 * tolerates empty input by returning `[]` instead of throwing — the
 * caller decides whether an empty list is fatal (it is for the
 * evolve path).
 */
function normalizeTagsInput(raw: readonly string[]): string[] {
  return validateTags(raw as unknown);
}

/**
 * Memory-v2 phase 3. Merge an `addTags` proposal into the target's
 * existing set with cap enforcement + new-tag detection. The legacy
 * `mergeTagSets` (used by dedup) is order-preserving but
 * cap-unaware; the evolve path needs both the resulting list AND
 * the subset of tags that were actually new (for trace events).
 *
 * `MEMORY_MAX_TAGS` is enforced — existing tags always win over
 * LLM-proposed extras when the cap is hit.
 */
function applyEvolveTags(
  existing: readonly string[],
  addTags: readonly string[],
): { tags: string[]; addedTags: string[] } {
  const merged: string[] = [...existing];
  const addedTags: string[] = [];
  for (const tag of addTags) {
    if (merged.length >= MEMORY_MAX_TAGS) break;
    if (merged.includes(tag)) continue;
    merged.push(tag);
    addedTags.push(tag);
  }
  return { tags: merged, addedTags };
}

function validateQuery(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new MemoryValidationError("query", "query must be a string");
  }
  const trimmed = raw.trim();
  if (trimmed.length > MEMORY_QUERY_MAX_LENGTH) {
    throw new MemoryValidationError(
      "query",
      `query must be at most ${MEMORY_QUERY_MAX_LENGTH} chars`,
    );
  }
  return trimmed;
}

function validateSource(raw: unknown): MemorySource {
  if (raw === "agent" || raw === "user") return raw;
  throw new MemoryValidationError(
    "source",
    `source must be 'agent' or 'user', got ${JSON.stringify(raw)}`,
  );
}

function validateOptionalString(
  raw: unknown,
  field: "sessionId" | "workingDir",
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new MemoryValidationError(field, `${field} must be a string or null`);
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function validateId(raw: unknown): number {
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw <= 0
  ) {
    throw new MemoryValidationError(
      "id",
      `id must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function clampPositiveInt(
  raw: unknown,
  min: number,
  max: number,
  field: "k" | "limit",
): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new MemoryValidationError(
      field,
      `${field} must be an integer, got ${JSON.stringify(raw)}`,
    );
  }
  if (raw < min) return min;
  if (raw > max) return max;
  return raw;
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: row.source === "user" ? "user" : "agent",
    sessionId: row.session_id,
    workingDir: row.working_dir,
    tags: parseTags(row.tags),
    // Memory-v2 phase 1A: columns default to 0 / NULL when read from
    // a v3 row migrated forward by `V4_MIGRATION`. Stored as INTEGER
    // in SQLite — coerce explicitly so JS-side comparisons stay safe.
    recallCount:
      typeof row.recall_count === "number" ? row.recall_count : 0,
    lastRecalledAt:
      typeof row.last_recalled_at === "number" ? row.last_recalled_at : null,
  };
}

/**
 * Memory-v2 phase 1A. Tokenise content for Jaccard similarity. Mirrors
 * the FTS5 tokeniser ((case-folded, drop non-`\p{L}\p{N}`), but emits a
 * `Set<string>` and skips trivial tokens (length ≤ 2) so common
 * stop-tokens like "a", "of" do not inflate the score on short inputs.
 *
 * Exported on the file scope (not the class) so phase 5's consolidator
 * can reuse the exact same normalisation rules without depending on a
 * MemoryStore instance — keeps invariant 14's ordering "dedup uses the
 * same token universe as consolidation" honest.
 */
function tokeniseForSimilarity(text: string): Set<string> {
  const set = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const t = raw.trim();
    if (t.length <= 2) continue;
    set.add(t);
  }
  return set;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  // Iterate the smaller set for cheaper lookups on `b.has(t)`.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) {
    if (large.has(t)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Memory-v2 phase 1A: true ⇔ `existing.tags ⊇ new.tags`. Empty new tag
 * set is trivially a subset of anything; same-set is a (trivial)
 * superset (so identical-tagged paraphrases merge). The check protects
 * against silent topic collapse: a NOTE tagged [`foo`] never absorbs
 * an INSERT tagged [`bar`] even if their content overlaps.
 */
function isTagSuperset(existing: string[], incoming: string[]): boolean {
  if (incoming.length === 0) return true;
  const set = new Set(existing);
  for (const t of incoming) {
    if (!set.has(t)) return false;
  }
  return true;
}

function mergeTagSets(a: string[], b: string[]): string[] {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of a) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  for (const t of b) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Reduce a freeform note to a single-line preview suitable for the
 * `### memory-index` section. The first non-empty line wins; anything
 * past `maxChars` is replaced with a single "…" so the prompt budget
 * does not blow up on long notes.
 */
export function renderNotePreview(content: string, maxChars: number): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";
  if (firstLine.length <= maxChars) return firstLine;
  if (maxChars <= 1) return firstLine.slice(0, maxChars);
  return `${firstLine.slice(0, maxChars - 1)}…`;
}

function clampPreviewChars(raw: unknown): number {
  if (raw === undefined || raw === null) return MEMORY_INDEX_PREVIEW_CHARS_DEFAULT;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    return MEMORY_INDEX_PREVIEW_CHARS_DEFAULT;
  }
  return Math.min(raw, MEMORY_INDEX_PREVIEW_CHARS_MAX);
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === "string");
    }
  } catch {
    // Malformed legacy tag payloads degrade to empty rather than throwing.
  }
  return [];
}

/**
 * FTS5 queries are their own tiny DSL: bare operators like `-`, `"`,
 * `(`, `*`, and column specifiers can make the grammar trip. Tokenize
 * on whitespace, drop anything non-alphanumeric-ish, wrap each surviving
 * token as a prefix match (`token*`), and join with OR so the caller
 * gets lenient keyword semantics. An empty output signals "no usable
 * terms — skip the query".
 */
function buildFtsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}
