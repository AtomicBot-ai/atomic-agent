import type Database from "better-sqlite3";

/**
 * Memory-v2 phase 1B. Read/write surface for the `memory_embeddings`
 * table. Stays narrow on purpose: one row per `(memory_id, model)`
 * pair, raw Float32 little-endian BLOB. `sqlite-vec` is intentionally
 * not wired in — JS-side brute-force cosine handles the v2 launch
 * corpus size; the schema is already shaped so a future migration can
 * graduate to a virtual table without rewriting callers.
 *
 * The store does NOT own the SQLite connection. The owning
 * `MemoryStore` opens the DB, enables `foreign_keys=ON`, and passes
 * the handle in here — that keeps lifecycle and PRAGMAs in one place
 * and lets the cascade `ON DELETE CASCADE` from `memories(id)` fire
 * automatically on memory removal.
 */
export interface EmbeddingRow {
  memoryId: number;
  model: string;
  dim: number;
  vector: Float32Array;
  createdAt: number;
}

export interface EmbeddingStoreOptions {
  db: Database.Database;
}

export class EmbeddingStore {
  private readonly db: Database.Database;
  private readonly upsertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly listByModelStmt: Database.Statement;
  private readonly countByModelStmt: Database.Statement;
  private readonly deleteByIdStmt: Database.Statement;
  private readonly deleteByModelStmt: Database.Statement;

  constructor(opts: EmbeddingStoreOptions) {
    this.db = opts.db;
    this.upsertStmt = this.db.prepare(
      `INSERT INTO memory_embeddings (memory_id, model, dim, embedding, created_at)
       VALUES (@memory_id, @model, @dim, @embedding, @created_at)
       ON CONFLICT(memory_id, model) DO UPDATE SET
         dim = excluded.dim,
         embedding = excluded.embedding,
         created_at = excluded.created_at`,
    );
    this.getStmt = this.db.prepare(
      `SELECT memory_id, model, dim, embedding, created_at
         FROM memory_embeddings WHERE memory_id = ? AND model = ?`,
    );
    // `list` joins `memories` so the brute-force cosine path can apply
    // the same scope/tag filters as FTS5 without a second round-trip.
    this.listByModelStmt = this.db.prepare(
      `SELECT e.memory_id AS memory_id, e.model AS model, e.dim AS dim,
              e.embedding AS embedding, e.created_at AS created_at,
              m.working_dir AS working_dir, m.tags AS tags
         FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id
        WHERE e.model = ?`,
    );
    this.countByModelStmt = this.db.prepare(
      `SELECT COUNT(*) AS count FROM memory_embeddings WHERE model = ?`,
    );
    this.deleteByIdStmt = this.db.prepare(
      `DELETE FROM memory_embeddings WHERE memory_id = ?`,
    );
    this.deleteByModelStmt = this.db.prepare(
      `DELETE FROM memory_embeddings WHERE model = ?`,
    );
  }

  /**
   * Insert or replace the embedding for `(memoryId, model)`. Idempotent:
   * a re-embed for the same row simply overwrites — useful when the
   * embedding model is upgraded in place.
   */
  upsert(row: EmbeddingRow): void {
    if (row.vector.length !== row.dim) {
      throw new Error(
        `EmbeddingStore: vector length ${row.vector.length} != dim ${row.dim}`,
      );
    }
    this.upsertStmt.run({
      memory_id: row.memoryId,
      model: row.model,
      dim: row.dim,
      embedding: float32ToBuffer(row.vector),
      created_at: row.createdAt,
    });
  }

  get(memoryId: number, model: string): EmbeddingRow | null {
    const row = this.getStmt.get(memoryId, model) as
      | {
          memory_id: number;
          model: string;
          dim: number;
          embedding: Buffer;
          created_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      memoryId: row.memory_id,
      model: row.model,
      dim: row.dim,
      vector: bufferToFloat32(row.embedding, row.dim),
      createdAt: row.created_at,
    };
  }

  /**
   * Full corpus scan for the given embedding model. Returned rows
   * carry `workingDir` and `tags` so the recall layer can apply the
   * same filters that FTS5 enforces in-query. Use sparingly — this is
   * the brute-force path for hybrid recall and is bounded by
   * `memory.embeddings.bruteForceCeiling` rows.
   */
  listByModel(model: string): Array<EmbeddingRow & {
    workingDir: string | null;
    tags: string[];
  }> {
    type Row = {
      memory_id: number;
      model: string;
      dim: number;
      embedding: Buffer;
      created_at: number;
      working_dir: string | null;
      tags: string | null;
    };
    const rows = this.listByModelStmt.all(model) as Row[];
    return rows.map((r) => ({
      memoryId: r.memory_id,
      model: r.model,
      dim: r.dim,
      vector: bufferToFloat32(r.embedding, r.dim),
      createdAt: r.created_at,
      workingDir: r.working_dir,
      tags: parseTags(r.tags),
    }));
  }

  countByModel(model: string): number {
    const row = this.countByModelStmt.get(model) as { count: number };
    return row.count;
  }

  /** Delete every embedding for a single `memoryId` across all models. */
  deleteAllForMemory(memoryId: number): number {
    const r = this.deleteByIdStmt.run(memoryId) as { changes: number };
    return r.changes;
  }

  /** Wipe a model's rows wholesale — used when migrating to a new model. */
  deleteAllForModel(model: string): number {
    const r = this.deleteByModelStmt.run(model) as { changes: number };
    return r.changes;
  }
}

function float32ToBuffer(v: Float32Array): Buffer {
  // Copy into a fresh buffer so the SQLite binding does not retain a
  // reference to a possibly-mutated ArrayBuffer.
  return Buffer.from(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

function bufferToFloat32(buf: Buffer, dim: number): Float32Array {
  // `Float32Array.from(new Float32Array(buf.buffer, buf.byteOffset, dim))`
  // could share memory; copy explicitly.
  if (buf.length !== dim * 4) {
    throw new Error(
      `EmbeddingStore: corrupt blob — expected ${dim * 4} bytes, got ${buf.length}`,
    );
  }
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i += 1) {
    out[i] = buf.readFloatLE(i * 4);
  }
  return out;
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === "string");
    }
  } catch {
    /* malformed legacy ⇒ empty */
  }
  return [];
}
