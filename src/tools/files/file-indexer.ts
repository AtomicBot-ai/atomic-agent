import { sep } from "node:path";

import { EmbeddingUnavailableError, type EmbeddingClient } from "../../memory/embeddings/embedding-client.js";
import { chunkSegments } from "./file-chunker.js";
import type { FileIndexStore } from "./file-index-store.js";
import type { FileIndexStatus } from "./file-index-types.js";
import type { FileTextResult } from "./file-text.js";
import type { FileVectorStore } from "./file-vector-store.js";
import type { WalkedFile, WalkOptions, WalkReport } from "./file-walker.js";

/**
 * The background indexer: one serial queue for every folder. A pass
 * walks each folder (new or changed files by mtime/size become pending,
 * files gone from disk are dropped), reads the pending files one at a
 * time, stores their chunks, then embeds the chunks the current
 * embedding model has no vector for. Passes requested while one runs
 * are folded into one more pass. `stop()` aborts the file in hand and
 * waits for the loop; a file cut short stays pending for the next run.
 */
export interface FileIndexerDeps {
  store: FileIndexStore;
  vectors: FileVectorStore | null;
  extract: (path: string, signal: AbortSignal) => Promise<FileTextResult>;
  walk: (root: string, options: WalkOptions) => Promise<WalkedFile[]>;
  embedding: () => EmbeddingClient | null;
  maxFileBytes: number;
  maxFilesPerFolder: number;
  now?: () => Date;
  /** Chunks embedded per batch before the loop yields. */
  embedBatch?: number;
}

export class FileIndexer {
  private loop: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private controller = new AbortController();
  private current: string | undefined;
  private lastError: FileIndexStatus["lastError"];
  private updatedAt: Date;

  constructor(private readonly deps: FileIndexerDeps) {
    this.updatedAt = this.now();
  }

  /** Queue a pass; returns at once. */
  requestPass(): void {
    if (this.stopped) return;
    this.again = true;
    if (this.loop === null) {
      this.loop = this.run()
        .catch((error: unknown) => {
          // A store error (the database closed under it) ends this run; the next request starts again.
          this.again = false;
          this.lastError = { path: this.current ?? "", message: error instanceof Error ? error.message : String(error), at: this.now().toISOString() };
        })
        .finally(() => {
          this.loop = null;
          this.current = undefined;
          this.touch();
          // A request that landed after the last check but before this.
          if (this.again && !this.stopped) this.requestPass();
        });
    }
  }

  /** Settles when the queue is empty (tests, `close`). */
  async idle(): Promise<void> {
    while (this.loop !== null) await this.loop;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.again = false;
    this.controller.abort();
    await this.idle();
  }

  status(): FileIndexStatus {
    return statusFrom(this.deps.store.counts(), {
      running: this.loop !== null,
      ...(this.current !== undefined ? { current: this.current } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      updatedAt: this.updatedAt.toISOString(),
    });
  }

  private async run(): Promise<void> {
    while (this.again && !this.stopped) {
      this.again = false;
      await this.walkAll();
      await this.readPending();
      await this.embedMissing();
    }
  }

  private async walkAll(): Promise<void> {
    const { store } = this.deps;
    for (const folder of store.folderPaths()) {
      if (this.stopped) return;
      const known = store.filesIn(folder);
      const report: WalkReport = { unreadable: [], truncated: false };
      const seen = await this.deps.walk(folder, {
        maxBytes: this.deps.maxFileBytes,
        maxFiles: this.deps.maxFilesPerFolder,
        signal: this.controller.signal,
        report,
      });
      if (this.stopped) return;
      // The folder may have been removed during the walk.
      if (!store.folderPaths().includes(folder)) continue;
      const present = new Set<string>();
      for (const file of seen) {
        present.add(file.path);
        const reason = file.tooLarge ? `larger than ${this.deps.maxFileBytes} bytes` : undefined;
        store.upsertSeen(folder, file.path, file.mtimeMs, file.size, known.get(file.path), reason);
      }
      // Only a file missing under a folder the walk did read is gone. An
      // unreadable root (unmounted drive, network share, permissions) or a
      // walk cut at maxFiles keeps every known file and its vectors. So
      // does a folder that held files and now walks empty: on Linux an
      // unmounted mountpoint reads as an empty folder (Syncthing refuses
      // to sync an emptied folder root for the same reason).
      if (report.unreadable.includes(folder)) {
        this.lastError = { path: folder, message: "folder is not readable right now; kept its index", at: this.now().toISOString() };
      } else if (seen.length === 0 && known.size > 0) {
        this.lastError = { path: folder, message: "folder looks empty now (unmounted drive?); kept its index", at: this.now().toISOString() };
      } else if (!report.truncated) {
        const blocked = report.unreadable.map((dir) => dir + sep);
        store.deleteFiles(
          [...known.values()]
            .filter((row) => !present.has(row.path) && !blocked.some((prefix) => row.path.startsWith(prefix)))
            .map((row) => row.id),
        );
      }
      this.touch();
    }
  }

  private async readPending(): Promise<void> {
    const { store } = this.deps;
    for (let file = store.nextPending(); file !== undefined && !this.stopped; file = store.nextPending()) {
      this.current = file.path;
      this.touch();
      const result = await this.deps.extract(file.path, this.controller.signal);
      if (this.stopped) return;
      if (result.status === "ok") {
        const ids = store.saveChunks(file.id, chunkSegments(result.segments), this.now().toISOString());
        if (ids !== null && ids.length === 0) store.markFile(file.id, "skipped", "no text in the file");
      } else if (result.status === "skipped") {
        store.markFile(file.id, "skipped", result.reason);
      } else {
        store.markFile(file.id, "failed", result.error);
        this.lastError = { path: file.path, message: result.error, at: this.now().toISOString() };
      }
      this.touch();
    }
    this.current = undefined;
  }

  /** Vectors for chunks the current model lacks. A model that stops answering ends it quietly. */
  private async embedMissing(): Promise<void> {
    const client = this.deps.embedding();
    const vectors = this.deps.vectors;
    if (client === null || vectors === null) return;
    const batch = this.deps.embedBatch ?? 16;
    for (;;) {
      if (this.stopped || this.again) return;
      const missing = vectors.missing(client.model, batch);
      if (missing.length === 0) return;
      for (const chunk of missing) {
        if (this.stopped) return;
        try {
          const result = await client.embed({ text: chunk.text, purpose: "document", signal: this.controller.signal });
          putIfStillThere(vectors, chunk.chunkId, client.model, result.vector);
        } catch (error) {
          if (error instanceof EmbeddingUnavailableError || this.controller.signal.aborted) return;
          throw error;
        }
      }
    }
  }

  private touch(): void {
    this.updatedAt = this.now();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

/** The chunk may have gone (its folder removed) while it was being embedded. */
function putIfStillThere(vectors: FileVectorStore, chunkId: number, model: string, vector: Float32Array): void {
  try {
    vectors.put(chunkId, model, vector);
  } catch {
    // FOREIGN KEY constraint: nothing to keep.
  }
}

/** The route's status from store counts and the loop's state. */
export function statusFrom(
  counts: { found: number; indexed: number; failed: number; skipped: number },
  state: Pick<FileIndexStatus, "running" | "current" | "lastError" | "updatedAt">,
): FileIndexStatus {
  return {
    running: state.running,
    found: counts.found,
    indexed: counts.indexed,
    failed: counts.failed,
    skipped: counts.skipped,
    ...(state.current !== undefined ? { current: state.current } : {}),
    ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
    updatedAt: state.updatedAt,
  };
}

/** Done when nothing runs and every found file is indexed, failed or skipped. */
export function isIndexDone(status: Pick<FileIndexStatus, "running" | "found" | "indexed" | "failed" | "skipped">): boolean {
  return !status.running && status.indexed + status.failed + status.skipped === status.found;
}
