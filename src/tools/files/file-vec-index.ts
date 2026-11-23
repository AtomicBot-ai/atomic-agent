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
 * table is resynced (missing rows added, orphans dropped). Any error turns
 * the mirror off for the process and search goes back to a scan.
 */
export class FileVecIndex {
  private readonly tables = new Map<string, string>();
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
    } catch {
      this.broken = true;
    }
  }

  /** The `k` chunk ids nearest to `query`, or `null` to fall back to a scan. */
  nearest(model: string, query: Float32Array, k: number): number[] | null {
    const table = this.table(model, query.length);
    if (table === null) return null;
    try {
      if (!this.inSync(table, model, query.length)) return null;
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

  private table(model: string, dim: number): string | null {
    if (this.broken || !Number.isInteger(dim) || dim < 1 || dim > MAX_DIM) return null;
    const key = `${model}\u0000${dim}`;
    const known = this.tables.get(key);
    if (known !== undefined) return known;
    const name = `chunk_vec_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(embedding float[${dim}] distance_metric=cosine)`);
    } catch {
      this.broken = true;
      return null;
    }
    this.tables.set(key, name);
    return name;
  }

  private inSync(table: string, model: string, dim: number): boolean {
    const want = this.vectors.countFor(model, dim);
    if (this.count(table) === want) return true;
    this.resync(table, model, dim);
    return this.count(table) === want;
  }

  private count(table: string): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint }).n);
  }

  /** Add what `chunk_vectors` has and the mirror lacks; drop what it no longer has. */
  private resync(table: string, model: string, dim: number): void {
    const run = this.db.transaction(() => {
      const mirrored = new Set(
        (this.db.prepare(`SELECT rowid AS id FROM ${table}`).all() as { id: number | bigint }[]).map((row) => Number(row.id)),
      );
      const wanted = new Set<number>();
      const page = this.db.prepare(
        `SELECT chunk_id AS chunkId, vector FROM chunk_vectors
          WHERE model = ? AND dim = ? AND chunk_id > ? ORDER BY chunk_id LIMIT ${RESYNC_BATCH}`,
      );
      const insert = this.db.prepare(`INSERT INTO ${table} (rowid, embedding) VALUES (?, ?)`);
      let after = -1;
      for (;;) {
        const rows = page.all(model, dim, after) as { chunkId: number; vector: Buffer }[];
        if (rows.length === 0) break;
        for (const row of rows) {
          wanted.add(row.chunkId);
          if (mirrored.has(row.chunkId)) continue;
          const vector = bufferToFloat32(row.vector, dim);
          if (vector !== null) insert.run(BigInt(row.chunkId), float32ToBuffer(vector));
        }
        after = rows[rows.length - 1]!.chunkId;
      }
      const drop = this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`);
      for (const id of mirrored) if (!wanted.has(id)) drop.run(BigInt(id));
    });
    run();
  }
}
