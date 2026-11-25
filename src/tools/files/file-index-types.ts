/**
 * Shapes of the "My files" index (ATO-1621, epic ATO-980). The HTTP
 * routes answer these objects as JSON, word for word: the desktop codes
 * to the same shapes (`/api/files/*`, see `src/http/route-files.ts`).
 */

/** One folder the person added. */
export interface IndexedFolder {
  /** Absolute, real path (symlinks resolved). */
  path: string;
  /** Its basename. */
  name: string;
  /** Supported files seen under it. */
  fileCount: number;
  /** Of those, the ones whose chunks are current. */
  indexedCount: number;
  /** ISO time it was added. */
  addedAt: string;
}

/**
 * Where the index stands. `found` counts the supported files seen in all
 * folders; it is done when `!running && indexed + failed + skipped === found`.
 */
export interface FileIndexStatus {
  running: boolean;
  found: number;
  indexed: number;
  failed: number;
  skipped: number;
  /** The file being read now. */
  current?: string;
  lastError?: { path: string; message: string; at: string };
  updatedAt: string;
}

/** Why a folder was refused; each is a `400 { error: { code, message } }`. */
export type FolderErrorCode =
  | "not_absolute"
  | "not_found"
  | "not_a_directory"
  | "already_added"
  | "inside_added"
  | "too_broad";

export class FolderRejectedError extends Error {
  constructor(
    readonly code: FolderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FolderRejectedError";
  }
}

/** What one file row is: waiting, read, failed to read, or left out. */
export type IndexedFileStatus = "pending" | "indexed" | "failed" | "skipped";

/** A passage of an indexed file that matched a search. */
export interface FileSearchHit {
  path: string;
  /** 1-based PDF page, when the passage comes from one. */
  page?: number;
  /** Seconds into an audio/video file, when known. */
  timeSec?: number;
  snippet: string;
  /** Higher is better; only comparable within one search. */
  score: number;
  /** A ready markdown link to paste as is (`file-cite.ts`). */
  cite: string;
}

export interface FileSearchOptions {
  query: string;
  /** Only this added folder (or a folder inside one). */
  folder?: string;
  /** 1..20, default 8. */
  topK?: number;
  signal?: AbortSignal;
}

/** The index as the runtime, the routes and `files.search` see it. */
export interface FileIndexApi {
  listFolders(): IndexedFolder[];
  /** Validates, adds and starts indexing. Throws {@link FolderRejectedError}. */
  addFolder(path: string): Promise<IndexedFolder>;
  /** Removes the folder and its chunks. `false` when it was not added. */
  removeFolder(path: string): Promise<boolean>;
  status(): FileIndexStatus;
  search(options: FileSearchOptions): Promise<FileSearchHit[]>;
}
