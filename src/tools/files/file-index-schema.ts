import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";

/**
 * The file index's own SQLite file (`<stateDir>/files-index.sqlite`),
 * apart from memory and sessions: it can grow large and be rebuilt from
 * the folders at any time, so deleting it loses nothing the person wrote.
 *
 *   - `folders`: the folders the person added.
 *   - `files`: every supported file seen in them, with the mtime and size
 *     it was read at, whether it is pending, indexed, failed or skipped,
 *     and how many scanned pages OCR read (`ocr_pages`, ATO-2501).
 *   - `chunks`: about 1000 characters of a file each, with the PDF page or
 *     the time offset the text comes from.
 *   - `chunks_fts`: FTS5 over `chunks.text` (external content, kept in
 *     step by triggers), the keyword half of search.
 *   - `chunk_vectors`: optional embeddings of chunks, per model, written
 *     only when memory embeddings are on.
 *
 * Rows are removed by the store in child-first order (vectors, chunks,
 * files, folder) rather than through cascades, so the FTS triggers
 * always see the delete.
 */
export const FILE_INDEX_SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS folders (
  path TEXT PRIMARY KEY,
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  folder TEXT NOT NULL REFERENCES folders(path),
  path TEXT NOT NULL UNIQUE,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'indexed', 'failed', 'skipped')),
  reason TEXT,
  indexed_at TEXT,
  ocr_pages INTEGER
);
CREATE INDEX IF NOT EXISTS files_by_folder ON files(folder);
CREATE INDEX IF NOT EXISTS files_by_status ON files(status);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id),
  ord INTEGER NOT NULL,
  page INTEGER,
  time_sec REAL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_by_file ON chunks(file_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TABLE IF NOT EXISTS chunk_vectors (
  chunk_id INTEGER NOT NULL REFERENCES chunks(id),
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (chunk_id, model)
);
CREATE INDEX IF NOT EXISTS chunk_vectors_by_model ON chunk_vectors(model);
`;

/** Open (creating when needed) the index database at `dbFile`. */
export function openFileIndexDb(dbFile: string): Database.Database {
  if (dbFile !== ":memory:") mkdirSync(dirname(dbFile), { recursive: true });
  const db = new DatabaseCtor(dbFile);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (version > FILE_INDEX_SCHEMA_VERSION) {
    throw new Error(
      `file index schema v${version} is newer than this agent (v${FILE_INDEX_SCHEMA_VERSION}); delete files-index.sqlite to rebuild it`,
    );
  }
  db.exec(DDL);
  addOcrPagesColumn(db);
  db.pragma(`user_version = ${FILE_INDEX_SCHEMA_VERSION}`);
}

/**
 * `files.ocr_pages` (ATO-2501) on a file made before it. Added without a
 * schema bump on purpose: the desktop and the terminal share one state
 * dir, and an older build refuses a newer `user_version` outright, while
 * an extra nullable column is invisible to it (it names its columns).
 */
function addOcrPagesColumn(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(files)`).all() as { name: string }[];
  if (!columns.some((column) => column.name === "ocr_pages")) db.exec(`ALTER TABLE files ADD COLUMN ocr_pages INTEGER`);
}

export function float32ToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

/** `null` for a blob of the wrong length (a corrupt or foreign row). */
export function bufferToFloat32(buffer: Buffer, dim: number): Float32Array | null {
  if (buffer.length !== dim * 4) return null;
  // A slice copies, so the offset of a pooled Buffer cannot misalign it.
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + dim * 4));
}
