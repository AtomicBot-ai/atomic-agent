import type Database from "better-sqlite3";

import { bufferToFloat32, float32ToBuffer } from "./file-index-schema.js";
import { likePrefix } from "./file-index-store.js";

export interface ChunkVector {
  chunkId: number;
  vector: Float32Array;
}

/**
 * Chunk embeddings (`chunk_vectors`), per embedding model, so a model
 * switch keeps the old rows until the new model has covered the chunks.
 * Read back whole for a brute-force cosine scan, the same trade-off
 * memory recall makes (`memory/embeddings/hybrid-recall.ts`): no
 * native vector extension to load, and `scanLimit` bounds the cost.
 */
export class FileVectorStore {
  constructor(private readonly db: Database.Database) {}

  put(chunkId: number, model: string, vector: Float32Array): void {
    this.db
      .prepare(
        `INSERT INTO chunk_vectors (chunk_id, model, dim, vector) VALUES (?, ?, ?, ?)
         ON CONFLICT(chunk_id, model) DO UPDATE SET dim = excluded.dim, vector = excluded.vector`,
      )
      .run(chunkId, model, vector.length, float32ToBuffer(vector));
  }

  countFor(model: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM chunk_vectors WHERE model = ?`).get(model) as { n: number }).n;
  }

  /** Chunks this model has no vector for, oldest first, with their text. */
  missing(model: string, limit: number): { chunkId: number; text: string }[] {
    return this.db
      .prepare(
        `SELECT c.id AS chunkId, c.text AS text FROM chunks AS c
          WHERE NOT EXISTS (SELECT 1 FROM chunk_vectors AS v WHERE v.chunk_id = c.id AND v.model = ?)
          ORDER BY c.id LIMIT ?`,
      )
      .all(model, limit) as { chunkId: number; text: string }[];
  }

  /**
   * The model's vectors, newest chunks first, at most `scanLimit`, plus
   * those of `alsoIds` (the keyword hits, so each keeps its re-rank),
   * optionally only for files under `under`.
   */
  scan(model: string, under: string | null, scanLimit: number, alsoIds: readonly number[] = []): ChunkVector[] {
    const filter = under === null ? "" : `AND f.path LIKE @under ESCAPE '\\'`;
    const rows = this.db
      .prepare(
        `SELECT v.chunk_id AS chunkId, v.dim AS dim, v.vector AS vector
           FROM chunk_vectors AS v
           JOIN chunks AS c ON c.id = v.chunk_id
           JOIN files AS f ON f.id = c.file_id
          WHERE v.model = @model ${filter}
          ORDER BY v.chunk_id DESC LIMIT @limit`,
      )
      .all({ model, limit: scanLimit, ...(under === null ? {} : { under: likePrefix(under) }) }) as {
      chunkId: number;
      dim: number;
      vector: Buffer;
    }[];
    const seen = new Set(rows.map((row) => row.chunkId));
    const extra = alsoIds.filter((id) => !seen.has(id));
    if (extra.length > 0) {
      const marks = extra.map(() => "?").join(",");
      rows.push(
        ...(this.db
          .prepare(`SELECT chunk_id AS chunkId, dim, vector FROM chunk_vectors WHERE model = ? AND chunk_id IN (${marks})`)
          .all(model, ...extra) as { chunkId: number; dim: number; vector: Buffer }[]),
      );
    }
    const out: ChunkVector[] = [];
    for (const row of rows) {
      const vector = bufferToFloat32(row.vector, row.dim);
      if (vector !== null) out.push({ chunkId: row.chunkId, vector });
    }
    return out;
  }
}
