import type Database from "better-sqlite3";

import type { EmbeddingWriter } from "./embedding-writer.js";

/**
 * Re-embed the notes that have no vector for the active embedding
 * model. `memory_embeddings` is keyed by `(memory_id, model)` and hybrid
 * recall reads only the active model's rows, so after a model switch, or
 * when embeddings are turned on over an existing corpus, every older
 * note is invisible to the cosine path until something embeds it again.
 * `EmbeddingWriter` only embeds at insert time; this walks the rest.
 *
 * The set is exactly what the writer embeds: every `memories` row (the
 * writer runs on each insert, archived rows included, since vector hits
 * do not filter on `consolidated_into`), with the stored content as the
 * text and purpose `document`. Writes go through the same writer, so the
 * metric and upsert path stay single.
 *
 * Newest first (by id, which is insertion order): recent memory becomes
 * searchable soonest when a run is cut short. Never throws: a model that
 * goes down stops the run quietly with what is left reported, and the
 * next run (the runtime's next boot, or `memory reindex`) picks it up.
 */
export interface EmbeddingBackfillDeps {
  /** The notes store's handle (`MemoryStore.getDatabaseHandleForEmbeddings`). */
  db: Database.Database;
  writer: Pick<EmbeddingWriter, "client" | "write">;
}

export interface EmbeddingBackfillProgress {
  embedded: number;
  skipped: number;
  /** Notes without a vector for the model when the run started. */
  total: number;
}

export interface EmbeddingBackfillOptions {
  /** Rows read per query. Default 16. */
  batchSize?: number;
  /** Embeds in flight at once. Default 1: the daemon is shared with live writes and recall. */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: EmbeddingBackfillProgress) => void;
  /**
   * Awaited between batches so a background run yields to the turn.
   * Default: one `setImmediate`.
   */
  pause?: () => Promise<void>;
}

/** Why a run ended before the corpus was covered. */
export type EmbeddingBackfillStopReason = "aborted" | "unavailable" | "failed";

export interface EmbeddingBackfillResult {
  model: string;
  embedded: number;
  /** Notes removed while the run was on them. */
  skipped: number;
  /** Notes still without a vector for the model. */
  remaining: number;
  stoppedReason?: EmbeddingBackfillStopReason;
}

const DEFAULT_BATCH_SIZE = 16;

// The composite primary key `(memory_id, model)` serves the NOT EXISTS
// probe, so neither query scans `memory_embeddings`.
const MISSING = `NOT EXISTS (
  SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id AND e.model = @model
)`;

/**
 * Notes with content that have no vector for `model`. Empty content is
 * left out here and in the run's own query alike (the writer would embed
 * nothing useful), so progress never passes the total.
 */
export function countPendingEmbeddings(db: Database.Database, model: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM memories m WHERE trim(m.content) <> '' AND ${MISSING}`,
    )
    .get({ model }) as { count: number };
  return row.count;
}

export async function backfillEmbeddings(
  deps: EmbeddingBackfillDeps,
  opts: EmbeddingBackfillOptions = {},
): Promise<EmbeddingBackfillResult> {
  const { db, writer } = deps;
  const model = writer.client.model;
  const batchSize = positiveInt(opts.batchSize, DEFAULT_BATCH_SIZE);
  const concurrency = positiveInt(opts.concurrency, 1);
  const pause = opts.pause ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const signal = opts.signal;
  let embedded = 0;
  let skipped = 0;
  let total = 0;
  let stoppedReason: EmbeddingBackfillStopReason | undefined;

  try {
    total = countPendingEmbeddings(db, model);
    const page = db.prepare(
      `SELECT m.id AS id, m.content AS content FROM memories m
        WHERE m.id < @before AND trim(m.content) <> '' AND ${MISSING}
        ORDER BY m.id DESC LIMIT @limit`,
    );
    const exists = db.prepare(`SELECT 1 FROM memories WHERE id = ?`);
    // Keyset cursor: a row the run could not embed is never read twice,
    // so one bad row cannot spin the loop.
    let before = Number.MAX_SAFE_INTEGER;
    outer: while (true) {
      if (signal?.aborted) {
        stoppedReason = "aborted";
        break;
      }
      const rows = page.all({ model, before, limit: batchSize }) as Array<{ id: number; content: string }>;
      if (rows.length === 0) break;
      before = rows[rows.length - 1]!.id;
      for (let i = 0; i < rows.length; i += concurrency) {
        if (signal?.aborted) {
          stoppedReason = "aborted";
          break outer;
        }
        const group = rows.slice(i, i + concurrency);
        const outcomes = await Promise.all(
          group.map((row) => writer.write(row.id, row.content, signal)),
        );
        let stop: EmbeddingBackfillStopReason | undefined;
        for (const [index, outcome] of outcomes.entries()) {
          if (outcome === "stored") embedded += 1;
          // Eviction or a user delete can remove a row between the read
          // and the upsert; its foreign key then fails. Not a reason to stop.
          else if (outcome === "failed" && !exists.get(group[index]!.id)) skipped += 1;
          else stop ??= outcome;
        }
        opts.onProgress?.({ embedded, skipped, total });
        if (stop) {
          // An abort surfaces from the client as an unavailable request.
          stoppedReason = signal?.aborted ? "aborted" : stop;
          break outer;
        }
      }
      await pause();
    }
  } catch {
    // The store closed under a background run (shutdown), or the schema
    // is not what this code expects: stop, never throw into the caller.
    stoppedReason = signal?.aborted ? "aborted" : "failed";
  }

  let remaining: number;
  try {
    remaining = countPendingEmbeddings(db, model);
  } catch {
    remaining = Math.max(0, total - embedded);
  }
  return { model, embedded, skipped, remaining, ...(stoppedReason ? { stoppedReason } : {}) };
}

function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}
