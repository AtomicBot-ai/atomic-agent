import type Database from "better-sqlite3";
import { resolve } from "node:path";

import type { EmbeddingClient } from "../../memory/embeddings/embedding-client.js";
import type { MediaTextOptions } from "../os/media-text/media-text.js";
import { openFileIndexDb } from "./file-index-schema.js";
import { FileIndexStore } from "./file-index-store.js";
import {
  FolderRejectedError,
  type FileIndexApi,
  type FileIndexStatus,
  type FileSearchHit,
  type FileSearchOptions,
  type IndexedFolder,
} from "./file-index-types.js";
import { FileIndexer } from "./file-indexer.js";
import { searchFileIndex } from "./file-search.js";
import { extractFileText, type FileTextOptions, type FileTextResult } from "./file-text.js";
import { FileVectorStore } from "./file-vector-store.js";
import { walkFolder, type WalkedFile, type WalkOptions } from "./file-walker.js";
import { isInside, validateFolder, type FolderValidationOptions } from "./folder-validation.js";

export const FILES_SEARCH_DEFAULT_TOP_K = 8;
export const FILES_SEARCH_MAX_TOP_K = 20;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_FILES_PER_FOLDER = 20_000;
/** Closest vector candidates one search keeps; every stored vector is still looked at. */
const DEFAULT_SCAN_LIMIT = 2_000;

export interface FileIndexOptions {
  /** `<stateDir>/files-index.sqlite`, or `:memory:` in tests. */
  dbFile: string;
  validation?: FolderValidationOptions;
  /**
   * The embedding model memory uses now (read on every call, so a model
   * switch carries over), or `null` for keyword-only search.
   */
  embedding?: () => EmbeddingClient | null;
  /** Memory's blend weights (`memory.embeddings.fts5Weight` / `vectorWeight`). */
  fts5Weight?: number;
  vectorWeight?: number;
  minCosine?: number;
  /** Photos and audio; off unless `enabled: true` (they cost model time). */
  media?: MediaTextOptions;
  maxFileBytes?: number;
  maxFilesPerFolder?: number;
  /** Test seams. */
  extract?: (path: string, signal: AbortSignal) => Promise<FileTextResult>;
  walk?: (root: string, options: WalkOptions) => Promise<WalkedFile[]>;
  extractors?: FileTextOptions["extractors"];
  now?: () => Date;
}

/**
 * The "My files" index (ATO-1621): the folders the person added, kept in
 * its own SQLite file and indexed in the background. The runtime owns
 * one; the `/api/files/*` routes and the `files.search` tool use it
 * through {@link FileIndexApi}.
 */
export class FileIndex implements FileIndexApi {
  private readonly db: Database.Database;
  private readonly store: FileIndexStore;
  private readonly vectors: FileVectorStore;
  private readonly indexer: FileIndexer;
  private closed = false;
  private startTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: FileIndexOptions) {
    this.db = openFileIndexDb(options.dbFile);
    this.store = new FileIndexStore(this.db);
    this.vectors = new FileVectorStore(this.db);
    const extract =
      options.extract ??
      ((path: string, signal: AbortSignal) =>
        extractFileText(path, {
          signal,
          ...(options.media ? { media: options.media } : {}),
          ...(options.extractors ? { extractors: options.extractors } : {}),
        }));
    this.indexer = new FileIndexer({
      store: this.store,
      vectors: this.vectors,
      extract,
      walk: options.walk ?? walkFolder,
      embedding: options.embedding ?? (() => null),
      maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      maxFilesPerFolder: options.maxFilesPerFolder ?? DEFAULT_MAX_FILES_PER_FOLDER,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  /** Catch up with what changed on disk since the last run. */
  start(): void {
    if (this.closed) return;
    if (this.store.folderPaths().length > 0) this.indexer.requestPass();
  }

  /**
   * {@link start} after `ms`, on an unref'd timer: a short-lived runtime
   * (`run`, `task run`) shuts down before it walks anything.
   */
  startAfter(ms: number): void {
    if (this.startTimer !== null || this.closed) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.start();
    }, ms);
    this.startTimer.unref();
  }

  listFolders(): IndexedFolder[] {
    return this.store.listFolders();
  }

  async addFolder(path: string): Promise<IndexedFolder> {
    const real = await validateFolder(path, this.store.folderPaths(), this.options.validation);
    let folder: IndexedFolder;
    try {
      folder = this.store.addFolder(real, this.now().toISOString());
    } catch (error) {
      // Two adds of one folder racing past the check: the second hits the key.
      if ((error as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT")) {
        throw new FolderRejectedError("already_added", `${real} is already in My files`);
      }
      throw error;
    }
    this.indexer.requestPass();
    return folder;
  }

  async removeFolder(path: string): Promise<boolean> {
    if (typeof path !== "string" || path.length === 0) {
      throw new FolderRejectedError("not_absolute", "pass the folder as an absolute path");
    }
    const wanted = resolve(path);
    // The path as added, or as the person typed it before symlinks were resolved.
    const match = this.store.folderPaths().find((added) => added === wanted || resolve(added) === wanted);
    return match === undefined ? false : this.store.removeFolder(match);
  }

  status(): FileIndexStatus {
    return this.indexer.status();
  }

  async search(options: FileSearchOptions): Promise<FileSearchHit[]> {
    const topK = Math.min(Math.max(1, Math.trunc(options.topK ?? FILES_SEARCH_DEFAULT_TOP_K)), FILES_SEARCH_MAX_TOP_K);
    const under = options.folder === undefined ? null : this.folderScope(options.folder);
    return searchFileIndex(
      {
        store: this.store,
        vectors: this.vectors,
        embedding: this.options.embedding ?? (() => null),
        fts5Weight: this.options.fts5Weight ?? 0.5,
        vectorWeight: this.options.vectorWeight ?? 0.5,
        ...(this.options.minCosine !== undefined ? { minCosine: this.options.minCosine } : {}),
        scanLimit: DEFAULT_SCAN_LIMIT,
      },
      { query: options.query, under, topK, ...(options.signal ? { signal: options.signal } : {}) },
    );
  }

  /** Settles when the background queue is empty. */
  idle(): Promise<void> {
    return this.indexer.idle();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.startTimer = null;
    await this.indexer.stop();
    this.db.close();
  }

  /** `folder` must be an added folder or inside one. */
  private folderScope(folder: string): string {
    const wanted = resolve(folder);
    const added = this.store.folderPaths();
    if (added.some((path) => path === wanted || isInside(wanted, path))) return wanted;
    throw new FolderRejectedError(
      "not_found",
      added.length === 0
        ? "no folders are in My files yet"
        : `${wanted} is not in My files; added folders: ${added.join(", ")}`,
    );
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
