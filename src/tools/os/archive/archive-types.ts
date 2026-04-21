export type ArchiveFormat = "zip" | "tar" | "tar.gz" | "gz";

export type ArchiveEntryKind = "file" | "directory" | "symlink";

export interface ArchiveEntry {
  /** Path inside the archive (forward slashes, no leading `/`). */
  path: string;
  kind: ArchiveEntryKind;
  /** Uncompressed size in bytes. `undefined` when the backend cannot tell without streaming the entry. */
  size?: number;
  /** Compressed size in bytes, when known (zip tracks this; tar does not). */
  compressedSize?: number;
  /** Last-modified timestamp, when provided by the archive. */
  mtime?: Date;
  /**
   * For symlinks, the target path stored inside the archive. Symlinks are
   * never materialised by the extractor unless `followSymlinks = true`.
   */
  linkTarget?: string;
}

export interface ExtractOptions {
  destDir: string;
  overwrite: boolean;
  followSymlinks: boolean;
  limits: ExtractLimits;
  /**
   * Optional path-prefix filter. When set, only entries whose normalised
   * path starts with one of these prefixes are extracted.
   */
  include?: readonly string[];
}

export interface ExtractLimits {
  maxTotalBytes: number;
  maxEntryBytes: number;
  maxEntries: number;
}

export interface ExtractReport {
  extractedEntries: number;
  totalBytesWritten: number;
  skippedEntries: Array<{ path: string; reason: string }>;
  warnings: string[];
}

export interface ArchiveBackend {
  readonly format: ArchiveFormat;
  list(data: Buffer): Promise<ArchiveEntry[]>;
  /**
   * Read a single entry as a Buffer. The backend MUST throw if the entry
   * is missing or not a regular file.
   */
  readEntry(data: Buffer, path: string): Promise<Buffer>;
  /**
   * Extract entries into `destDir`, applying the provided caps and the
   * sanitizer for zip-slip defense. Returns a report of skipped/warned
   * entries instead of aborting on the first problem so the caller can
   * surface a useful summary.
   */
  extract(data: Buffer, options: ExtractOptions): Promise<ExtractReport>;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxTotalBytes: 100 * 1024 * 1024, // 100 MB
  maxEntryBytes: 10 * 1024 * 1024, // 10 MB
  maxEntries: 10_000,
};
