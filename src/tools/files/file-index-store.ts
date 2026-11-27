import type Database from "better-sqlite3";
import { basename, sep } from "node:path";

import type { FileChunk } from "./file-chunker.js";
import type { IndexedFileStatus, IndexedFolder } from "./file-index-types.js";

/** One `files` row as the indexer reads it. */
export interface FileRow {
  id: number;
  folder: string;
  path: string;
  mtimeMs: number;
  size: number;
  status: IndexedFileStatus;
}

/** A keyword match, best first. `bm25` is FTS5's: negative, lower is better. */
export interface ChunkMatch {
  chunkId: number;
  path: string;
  page: number | null;
  timeSec: number | null;
  snippet: string;
  bm25: number;
}

export interface ChunkRow {
  chunkId: number;
  path: string;
  page: number | null;
  timeSec: number | null;
  text: string;
}

export interface FileCounts {
  found: number;
  indexed: number;
  failed: number;
  skipped: number;
  pending: number;
}

/**
 * Folders, files and chunks of the file index (`file-index-schema.ts`).
 * Synchronous better-sqlite3 calls; the indexer runs them between awaits,
 * one file at a time.
 */
export class FileIndexStore {
  constructor(private readonly db: Database.Database) {}

  // ── folders ────────────────────────────────────────────────────────────

  folderPaths(): string[] {
    return (this.db.prepare(`SELECT path FROM folders ORDER BY path`).all() as { path: string }[]).map((r) => r.path);
  }

  listFolders(): IndexedFolder[] {
    const rows = this.db
      .prepare(
        `SELECT f.path AS path, f.added_at AS addedAt,
                COUNT(x.id) AS fileCount,
                COALESCE(SUM(CASE WHEN x.status = 'indexed' THEN 1 ELSE 0 END), 0) AS indexedCount
           FROM folders AS f LEFT JOIN files AS x ON x.folder = f.path
          GROUP BY f.path ORDER BY f.added_at, f.path`,
      )
      .all() as { path: string; addedAt: string; fileCount: number; indexedCount: number }[];
    return rows.map((r) => ({ path: r.path, name: basename(r.path) || r.path, fileCount: r.fileCount, indexedCount: r.indexedCount, addedAt: r.addedAt }));
  }

  getFolder(path: string): IndexedFolder | undefined {
    return this.listFolders().find((folder) => folder.path === path);
  }

  /**
   * Add `path` (already validated). Folders inside it are taken in: their
   * files move under it and their rows go, so no file is indexed twice.
   */
  addFolder(path: string, addedAt: string): IndexedFolder {
    const prefix = path.endsWith(sep) ? path : `${path}${sep}`;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO folders (path, added_at) VALUES (?, ?)`).run(path, addedAt);
      const inner = this.folderPaths().filter((other) => other !== path && other.startsWith(prefix));
      for (const child of inner) {
        this.db.prepare(`UPDATE files SET folder = ? WHERE folder = ?`).run(path, child);
        this.db.prepare(`DELETE FROM folders WHERE path = ?`).run(child);
      }
    })();
    return this.getFolder(path)!;
  }

  /** Remove the folder with its files, chunks and vectors. */
  removeFolder(path: string): boolean {
    return this.db.transaction(() => {
      const ids = (this.db.prepare(`SELECT id FROM files WHERE folder = ?`).all(path) as { id: number }[]).map((r) => r.id);
      this.deleteFilesNow(ids);
      return this.db.prepare(`DELETE FROM folders WHERE path = ?`).run(path).changes > 0;
    })();
  }

  // ── files ──────────────────────────────────────────────────────────────

  filesIn(folder: string): Map<string, FileRow> {
    const rows = this.db
      .prepare(`SELECT id, folder, path, mtime_ms AS mtimeMs, size, status FROM files WHERE folder = ?`)
      .all(folder) as FileRow[];
    return new Map(rows.map((row) => [row.path, row]));
  }

  /**
   * Record a file the walk saw. New, or changed since it was read (mtime
   * or size): `pending`, or `skipped` with `skipReason` (a file over the
   * size cap). Unchanged: left as it is.
   */
  upsertSeen(folder: string, path: string, mtimeMs: number, size: number, known: FileRow | undefined, skipReason?: string): void {
    const status: IndexedFileStatus = skipReason === undefined ? "pending" : "skipped";
    if (known === undefined) {
      this.db
        .prepare(`INSERT INTO files (folder, path, mtime_ms, size, status, reason) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(folder, path, Math.trunc(mtimeMs), size, status, skipReason ?? null);
      return;
    }
    // Failed and skipped files are read again only once they change.
    if (known.mtimeMs === Math.trunc(mtimeMs) && known.size === size) return;
    this.db.transaction(() => {
      this.deleteChunksOf(known.id);
      this.db
        .prepare(`UPDATE files SET mtime_ms = ?, size = ?, status = ?, reason = ?, indexed_at = NULL WHERE id = ?`)
        .run(Math.trunc(mtimeMs), size, status, skipReason ?? null, known.id);
    })();
  }

  /** Files gone from disk since the last walk. */
  deleteFiles(ids: readonly number[]): void {
    if (ids.length === 0) return;
    this.db.transaction(() => this.deleteFilesNow(ids))();
  }

  nextPending(): FileRow | undefined {
    return this.db
      .prepare(`SELECT id, folder, path, mtime_ms AS mtimeMs, size, status FROM files WHERE status = 'pending' ORDER BY id LIMIT 1`)
      .get() as FileRow | undefined;
  }

  /**
   * Store the chunks of a file just read and mark it `indexed`. Returns
   * the chunk ids, or `null` when the file was removed meanwhile (its
   * folder went while it was being read).
   */
  saveChunks(fileId: number, chunks: readonly FileChunk[], at: string, ocrPages = 0): number[] | null {
    return this.db.transaction(() => {
      if (this.db.prepare(`SELECT 1 FROM files WHERE id = ?`).get(fileId) === undefined) return null;
      this.deleteChunksOf(fileId);
      const insert = this.db.prepare(`INSERT INTO chunks (file_id, ord, page, time_sec, text) VALUES (?, ?, ?, ?, ?)`);
      const ids = chunks.map((c) => Number(insert.run(fileId, c.ord, c.page ?? null, c.timeSec ?? null, c.text).lastInsertRowid));
      this.db
        .prepare(`UPDATE files SET status = 'indexed', reason = NULL, indexed_at = ?, ocr_pages = ? WHERE id = ?`)
        .run(at, ocrPages > 0 ? ocrPages : null, fileId);
      return ids;
    })();
  }

  markFile(fileId: number, status: "failed" | "skipped", reason: string): void {
    this.db.prepare(`UPDATE files SET status = ?, reason = ? WHERE id = ?`).run(status, reason.slice(0, 500), fileId);
  }

  /**
   * Skipped files whose reason `retry` accepts go back to `pending`, so
   * the next pass reads them again (ATO-2501: a reader turned on or
   * installed since). Returns how many.
   */
  requeueSkipped(retry: (reason: string) => boolean): number {
    const rows = this.db.prepare(`SELECT id, reason FROM files WHERE status = 'skipped'`).all() as { id: number; reason: string | null }[];
    const ids = rows.filter((row) => row.reason !== null && retry(row.reason)).map((row) => row.id);
    if (ids.length === 0) return 0;
    const update = this.db.prepare(`UPDATE files SET status = 'pending', reason = NULL WHERE id = ? AND status = 'skipped'`);
    this.db.transaction(() => {
      for (const id of ids) update.run(id);
    })();
    return ids.length;
  }

  /** The most common skip reasons, most files first. */
  skipReasons(limit: number): { reason: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT COALESCE(reason, 'unknown') AS reason, COUNT(*) AS count FROM files
          WHERE status = 'skipped' GROUP BY COALESCE(reason, 'unknown') ORDER BY count DESC, reason LIMIT ?`,
      )
      .all(limit) as { reason: string; count: number }[];
  }

  /** Scanned pages OCR read, over the files indexed now. */
  ocrPages(): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(ocr_pages), 0) AS n FROM files WHERE status = 'indexed'`).get() as { n: number };
    return row.n;
  }

  counts(): FileCounts {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM files GROUP BY status`).all() as { status: IndexedFileStatus; n: number }[];
    const counts: FileCounts = { found: 0, indexed: 0, failed: 0, skipped: 0, pending: 0 };
    for (const row of rows) {
      counts[row.status] += row.n;
      counts.found += row.n;
    }
    return counts;
  }

  // ── chunks ─────────────────────────────────────────────────────────────

  /** FTS5 match over chunks, optionally under one folder path prefix. */
  matchChunks(match: string, under: string | null, limit: number): ChunkMatch[] {
    return this.db
      .prepare(
        `SELECT c.id AS chunkId, f.path AS path, c.page AS page, c.time_sec AS timeSec,
                snippet(chunks_fts, 0, '«', '»', '…', 32) AS snippet,
                bm25(chunks_fts) AS bm25
           FROM chunks_fts
           JOIN chunks AS c ON c.id = chunks_fts.rowid
           JOIN files AS f ON f.id = c.file_id
          WHERE chunks_fts MATCH @match
            AND (@under IS NULL OR f.path LIKE @under ESCAPE '\\')
          ORDER BY bm25(chunks_fts) ASC
          LIMIT @limit`,
      )
      .all({ match, under: under === null ? null : likePrefix(under), limit }) as ChunkMatch[];
  }

  chunksById(ids: readonly number[]): ChunkRow[] {
    if (ids.length === 0) return [];
    const marks = ids.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT c.id AS chunkId, f.path AS path, c.page AS page, c.time_sec AS timeSec, c.text AS text
           FROM chunks AS c JOIN files AS f ON f.id = c.file_id WHERE c.id IN (${marks})`,
      )
      .all(...ids) as ChunkRow[];
  }

  private deleteChunksOf(fileId: number): void {
    this.db.prepare(`DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)`).run(fileId);
    this.db.prepare(`DELETE FROM chunks WHERE file_id = ?`).run(fileId);
  }

  private deleteFilesNow(ids: readonly number[]): void {
    const remove = this.db.prepare(`DELETE FROM files WHERE id = ?`);
    for (const id of ids) {
      this.deleteChunksOf(id);
      remove.run(id);
    }
  }
}

/** `LIKE` pattern for paths under `folder`, with `%`, `_` and `\` escaped. */
export function likePrefix(folder: string): string {
  const prefix = folder.endsWith(sep) ? folder : `${folder}${sep}`;
  return `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
