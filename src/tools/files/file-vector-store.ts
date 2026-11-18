import type Database from "better-sqlite3";

import { bufferToFloat32, float32ToBuffer } from "./file-index-schema.js";
import { likePrefix } from "./file-index-store.js";

export interface ChunkVector {
  chunkId: number;
  vector: Float32Array;
}

/** Gets a copy of every vector written ([sqlite-vec mirror](file-vec-index.ts)). */
export interface VectorMirror {
  put(chunkId: number, model: string, vector: Float32Array): void;
}

/**
 * Chunk embeddings (`chunk_vectors`), per embedding model, so a model
 * switch keeps the old rows until the new model has covered the chunks.
 * Read back whole for a brute-force cosine scan, the same trade-off
 * memory recall makes (`memory/embeddings/hybrid-recall.ts`), and
 * `scanLimit` bounds the cost. When `sqlite-vec` is installed a mirror
 * picks the candidates instead and {@link byIds} reads them back.
 */
export class FileVectorStore {
  private mirror: VectorMirror | null = null;

  constructor(private readonly db: Database.Database) {}

  setMirror(mirror: VectorMirror | null): void {
    this.mirror = mirror;
  }

  put(chunkId: number, model: string, vector: Float32Array): void {
    this.db
      .prepare(
        `INSERT INTO chunk_vectors (chunk_id, model, dim, vector) VALUES (?, ?, ?, ?)
         ON CONFLICT(chunk_id, model) DO UPDATE SET dim = excluded.dim, vector = excluded.vector`,
      )
      .run(chunkId, model, vector.length, float32ToBuffer(vector));
    this.mirror?.put(chunkId, model, vector);
  }

  /** Vectors of `model`, of one dimension when `dim` is given. */
  countFor(model: string, dim?: number): number {
    if (dim === undefined) {
      return (this.db.prepare(`SELECT COUNT(*) AS n FROM chunk_vectors WHERE model = ?`).get(model) as { n: number }).n;
    }
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM chunk_vectors WHERE model = ? AND dim = ?`).get(model, dim) as { n: number }).n;
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
      .all({ model, limit: scanLimit, ...(under === null ? {} : { under: likePrefix(under) }) }) as VectorRow[];
    const seen = new Set(rows.map((row) => row.chunkId));
    return [...decode(rows), ...this.byIds(model, alsoIds.filter((id) => !seen.has(id)))];
  }

  /** The model's vectors of these chunks (those it has). */
  byIds(model: string, ids: readonly number[]): ChunkVector[] {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const out: ChunkVector[] = [];
    // Stay well under SQLite's bound-parameter limit.
    for (let i = 0; i < unique.length; i += 500) {
      const part = unique.slice(i, i + 500);
      const marks = part.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT chunk_id AS chunkId, dim, vector FROM chunk_vectors WHERE model = ? AND chunk_id IN (${marks})`)
        .all(model, ...part) as VectorRow[];
      out.push(...decode(rows));
    }
    return out;
  }
}

interface VectorRow {
  chunkId: number;
  dim: number;
  vector: Buffer;
}

function decode(rows: readonly VectorRow[]): ChunkVector[] {
  const out: ChunkVector[] = [];
  for (const row of rows) {
    const vector = bufferToFloat32(row.vector, row.dim);
    if (vector !== null) out.push({ chunkId: row.chunkId, vector });
  }
  return out;
}
