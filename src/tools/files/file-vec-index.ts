import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

import { bufferToFloat32, float32ToBuffer } from "./file-index-schema.js";
import type { FileVectorStore } from "./file-vector-store.js";

/** sqlite-vec's cap on `k` in one KNN query. */
export const VEC_K_MAX = 4096;
const MAX_DIM = 8192;
const RESYNC_BATCH = 500;

/**
 * A `vec0` mirror of `chunk_vectors` (ATO-1052), used only when the
 * `sqlite-vec` extension loaded ([loader](file-vec-extension.ts)).
 *
 * It only picks candidate chunk ids: search re-scores them with the exact
 * cosine from `chunk_vectors`, so a stale or orphan row here can cost a
 * candidate slot but never a wrong score. One table per model and
 * dimension. `put` mirrors every write; deletes are not mirrored, and the
 * row counts are compared before each query instead: when they differ the
 * table is resynced (missing rows added, orphans dropped). A resync
 * compares ids only and reads the vector blob of just the rows the mirror
 * lacks (ATO-1657). A row whose blob never decodes is remembered as
 * skipped (in memory, until `put` rewrites it or the row is gone) and
 * counted as mirrored, so it does not force a resync and a scan on every
 * search. Any error turns the mirror off for the process and search goes
 * back to a scan.
 */
export class FileVecIndex {
  private readonly tables = new Map<string, string>();
  /** Per table, `chunk_vectors` rows whose blob does not decode, so they are never mirrored. */
  private readonly skipped = new Map<string, Set<number>>();
  private broken = false;

  constructor(
    private readonly db: Database.Database,
    private readonly vectors: Pick<FileVectorStore, "countFor">,
  ) {}

  get active(): boolean {
    return !this.broken;
  }

  /** Mirror one vector. Never throws. */
  put(chunkId: number, model: string, vector: Float32Array): void {
    const table = this.table(model, vector.length);
    if (table === null) return;
    try {
      this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(chunkId));
      this.db.prepare(`INSERT INTO ${table} (rowid, embedding) VALUES (?, ?)`).run(BigInt(chunkId), float32ToBuffer(vector));
      this.skipped.get(table)?.delete(chunkId);
    } catch {
      this.broken = true;
    }
  }

  /** The `k` chunk ids nearest to `query`, or `null` to fall back to a scan. */
  nearest(model: string, query: Float32Array, k: number): number[] | null {
    const table = this.table(model, query.length);
    if (table === null) return null;
    try {
      if (!this.syncTable(table, model, query.length)) return null;
      const limit = Math.max(1, Math.min(VEC_K_MAX, Math.trunc(k)));
      const rows = this.db
        .prepare(`SELECT rowid AS id FROM ${table} WHERE embedding MATCH ? AND k = ${limit}`)
        .all(float32ToBuffer(query)) as { id: number | bigint }[];
      return rows.map((row) => Number(row.id));
    } catch {
      this.broken = true;
      return null;
    }
  }

  /**
   * Bring the mirror of `model` at `dim` up to date; whether it now matches
   * `chunk_vectors` (skipped rows count as mirrored). Never throws.
   */
  sync(model: string, dim: number): boolean {
    const table = this.table(model, dim);
    if (table === null) return false;
    try {
      return this.syncTable(table, model, dim);
    } catch {
      this.broken = true;
      return false;
    }
  }

  private table(model: string, dim: number): string | null {
    if (this.broken || !Number.isInteger(dim) || dim < 1 || dim > MAX_DIM) return null;
    const key = `${model}\u0000${dim}`;
    const known = this.tables.get(key);
    if (known !== undefined) return known;
    const name = vecTableName(model, dim);
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(embedding float[${dim}] distance_metric=cosine)`);
    } catch {
      this.broken = true;
      return null;
    }
    this.tables.set(key, name);
    return name;
  }

  private syncTable(table: string, model: string, dim: number): boolean {
    const want = this.vectors.countFor(model, dim);
    if (this.mirroredCount(table) === want) return true;
    this.resync(table, model, dim);
    return this.mirroredCount(table) === want;
  }

  /** Rows in the mirror plus the rows it skips as undecodable. */
  private mirroredCount(table: string): number {
    return this.count(table) + (this.skipped.get(table)?.size ?? 0);
  }

  private count(table: string): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint }).n);
  }

  /**
   * Add what `chunk_vectors` has and the mirror lacks; drop what it no
   * longer has. Ids are compared first; only the missing rows' blobs are
   * read, and a blob that does not decode is skipped from then on.
   */
  private resync(table: string, model: string, dim: number): void {
    const run = this.db.transaction(() => {
      const mirrored = new Set(
        (this.db.prepare(`SELECT rowid AS id FROM ${table}`).all() as { id: number | bigint }[]).map((row) => Number(row.id)),
      );
      const oldSkipped = this.skipped.get(table) ?? new Set<number>();
      const skipped = new Set<number>();
      const missing: number[] = [];
      const wanted = new Set<number>();
      const ids = this.db.prepare(`SELECT chunk_id AS chunkId FROM chunk_vectors WHERE model = ? AND dim = ?`);
      for (const row of ids.iterate(model, dim) as Iterable<{ chunkId: number }>) {
        wanted.add(row.chunkId);
        if (mirrored.has(row.chunkId)) continue;
        if (oldSkipped.has(row.chunkId)) skipped.add(row.chunkId);
        else missing.push(row.chunkId);
      }
      const insert = this.db.prepare(`INSERT INTO ${table} (rowid, embedding) VALUES (?, ?)`);
      // Stay well under SQLite's bound-parameter limit.
      for (let i = 0; i < missing.length; i += RESYNC_BATCH) {
        const part = missing.slice(i, i + RESYNC_BATCH);
        const rows = this.db
          .prepare(
            `SELECT chunk_id AS chunkId, vector FROM chunk_vectors
              WHERE model = ? AND dim = ? AND chunk_id IN (${part.map(() => "?").join(",")})`,
          )
          .all(model, dim, ...part) as { chunkId: number; vector: Buffer }[];
        for (const row of rows) {
          const vector = bufferToFloat32(row.vector, dim);
          if (vector === null) skipped.add(row.chunkId);
          else insert.run(BigInt(row.chunkId), float32ToBuffer(vector));
        }
      }
      const drop = this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`);
      for (const id of mirrored) if (!wanted.has(id)) drop.run(BigInt(id));
      return skipped;
    });
    this.skipped.set(table, run());
  }
}

/** The vec0 table that mirrors `model` at `dim`. */
export function vecTableName(model: string, dim: number): string {
  return `chunk_vec_${createHash("sha256").update(`${model}\u0000${dim}`).digest("hex").slice(0, 16)}`;
}
