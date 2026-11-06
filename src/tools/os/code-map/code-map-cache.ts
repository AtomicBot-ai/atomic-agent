import type { FileOutline } from "./outline-types.js";

/**
 * Outlines by absolute path, valid while the file's mtime and size hold.
 * A second `os.fs.code_map` on the same tree re-reads only what changed.
 * Process-wide and bounded; the oldest entry goes first.
 */
export const CODE_MAP_CACHE_MAX_ENTRIES = 5_000;

interface Entry {
  mtimeMs: number;
  size: number;
  outline: FileOutline;
}

export class OutlineCache {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly maxEntries = CODE_MAP_CACHE_MAX_ENTRIES) {}

  get(backendId: string, path: string, mtimeMs: number, size: number): FileOutline | undefined {
    const key = `${backendId}\0${path}`;
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.mtimeMs !== mtimeMs || hit.size !== size) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.outline;
  }

  set(backendId: string, path: string, mtimeMs: number, size: number, outline: FileOutline): void {
    const key = `${backendId}\0${path}`;
    this.entries.delete(key);
    this.entries.set(key, { mtimeMs, size, outline });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
