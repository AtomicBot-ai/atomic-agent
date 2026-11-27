import type Database from "better-sqlite3";

import { cosineSimilarity } from "../../memory/embeddings/hybrid-recall.js";

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
 * Read back for a brute-force cosine scan, the same trade-off memory
 * recall makes (`memory/embeddings/hybrid-recall.ts`): no native vector
 * extension to load. With a query vector every row is read, in pages
 * that yield to the event loop, and only the best `scanLimit` are kept,
 * so old chunks are candidates too.
 * When `sqlite-vec` is installed a mirror picks the candidates instead
 * and {@link byIds} reads them back.
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
   * The model's vectors to score, optionally only for files under `under`,
   * plus those of `alsoIds` (the keyword hits, so each keeps its re-rank).
   * With `query`, every row is read (paged, yielding) and the `scanLimit` closest by
   * cosine are kept (no chunk is out of reach because it is old). Without
   * it, the newest `scanLimit` (callers that do not score).
   */
  async scan(
    model: string,
    under: string | null,
    scanLimit: number,
    alsoIds: readonly number[] = [],
    query?: Float32Array,
  ): Promise<ChunkVector[]> {
    const filter = under === null ? "" : `AND f.path LIKE @under ESCAPE '\\'`;
    const params = { model, ...(under === null ? {} : { under: likePrefix(under) }) };
    const rows: VectorRow[] = [];
    if (query !== undefined) {
      rows.push(...(await this.closest(filter, params, Math.max(1, scanLimit), query)));
    } else {
      rows.push(
        ...(this.db
          .prepare(
            `SELECT v.chunk_id AS chunkId, v.dim AS dim, v.vector AS vector
               FROM chunk_vectors AS v
               JOIN chunks AS c ON c.id = v.chunk_id
               JOIN files AS f ON f.id = c.file_id
              WHERE v.model = @model ${filter}
              ORDER BY v.chunk_id DESC LIMIT @limit`,
          )
          .all({ ...params, limit: scanLimit }) as VectorRow[]),
      );
    }
    const seen = new Set(rows.map((row) => row.chunkId));
    return [...decode(rows), ...this.byIds(model, alsoIds.filter((id) => !seen.has(id)))];
  }

  /**
   * The `keep` rows closest to `query` by cosine, over every stored row.
   * Read in pages of {@link SCAN_PAGE} by chunk id, yielding to the event
   * loop between pages so a large index does not stall the process. A
   * page is read with `.all()`, never an open iterator across the yield:
   * better-sqlite3 refuses other statements on the connection while one
   * is open, and the indexer writes on it meanwhile.
   */
  private async closest(
    filter: string,
    params: Record<string, string>,
    keep: number,
    query: Float32Array,
  ): Promise<VectorRow[]> {
    const stmt = this.db.prepare(
      `SELECT v.chunk_id AS chunkId, v.dim AS dim, v.vector AS vector
         FROM chunk_vectors AS v
         JOIN chunks AS c ON c.id = v.chunk_id
         JOIN files AS f ON f.id = c.file_id
        WHERE v.model = @model AND v.chunk_id > @after ${filter}
        ORDER BY v.chunk_id LIMIT @page`,
    );
    let best: { row: VectorRow; score: number }[] = [];
    let after = -1;
    for (;;) {
      const page = stmt.all({ ...params, after, page: SCAN_PAGE }) as VectorRow[];
      for (const row of page) {
        if (row.dim !== query.length) continue;
        const vector = bufferToFloat32(row.vector, row.dim);
        if (vector === null) continue;
        best.push({ row, score: cosineSimilarity(query, vector) });
        if (best.length >= keep * 2) best = best.sort((a, b) => b.score - a.score).slice(0, keep);
      }
      if (page.length < SCAN_PAGE) break;
      after = page[page.length - 1]!.chunkId;
      await yieldToEventLoop();
    }
    return best.sort((a, b) => b.score - a.score).slice(0, keep).map((b) => b.row);
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

/** Rows scored between two yields to the event loop. */
export const SCAN_PAGE = 2000;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
