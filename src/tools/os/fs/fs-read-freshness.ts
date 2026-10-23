import { open, realpath, stat } from "node:fs/promises";
import {
  retainToolOutput,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import { hashReadContent } from "./fs-read-coverage.js";

/**
 * "The file changed since you last read it" (ATO-659).
 *
 * `os.fs.read` already fingerprints the bytes it looked at for the
 * read-coverage detector (`fs-read-coverage.ts`). This module keeps the
 * last such fingerprint per file and lets `os.fs.write` (replace),
 * `os.fs.edit` and `os.fs.patch` ask, right before they touch the file,
 * whether it still holds what the model last saw. When it does not (the
 * user saved it in their editor, another worker or a shell command
 * rewrote it) the write still runs, and the result carries a notice
 * telling the model to re-read before editing again. A notice, never a
 * refusal: the edit tools already match on the current content, and a
 * refusal would block legitimate work on a file a formatter touched.
 *
 * Our own writes update the stored fingerprint, so a read, an edit and a
 * second edit of the same file never raise the notice against the
 * agent's own change.
 *
 * The comparison is the read's own: same file size, and the same digest
 * over the same prefix the read hashed (`hashedBytes`). A file that grew
 * or shrank differs in size; a same-size in-place change differs in the
 * digest. Content past a byte-capped read's prefix is not compared when
 * the size is unchanged, matching what the model could have seen.
 *
 * Any I/O failure while checking is silence: the notice is advice, and a
 * check that cannot run must never fail or block the write.
 */

/** First line of a write/edit/patch result whose target changed since the last read. */
export const STALE_READ_NOTICE =
  "note: this file changed since you last read it; re-read it before editing it again.";

/** Prefix hashed after our own write when no earlier read set one (the `os.fs.read` default). */
export const FRESHNESS_HASH_BYTES = 64 * 1024;

/** How many files one store remembers; the least recently touched is dropped first. */
export const MAX_TRACKED_FILE_VERSIONS = 256;

/** What a read (or our own write) saw of one file. */
export interface FileReadVersion {
  /** File size in bytes at that moment. */
  size: number;
  /** Length of the prefix `contentHash` covers: `min(size, read budget)`. */
  hashedBytes: number;
  /** `hashReadContent` of that prefix. */
  contentHash: string;
}

/**
 * Last-seen version per canonical (symlink-resolved) path. One store per
 * turn, owned by the loop tracker and handed to tools through
 * `ToolContext.fileVersions`.
 */
export class FileReadVersions {
  private readonly versions = new Map<string, FileReadVersion>();

  get(canonicalPath: string): FileReadVersion | undefined {
    return this.versions.get(canonicalPath);
  }

  record(canonicalPath: string, version: FileReadVersion): void {
    // Re-insert so Map order stays least-recently-touched first.
    this.versions.delete(canonicalPath);
    this.versions.set(canonicalPath, version);
    while (this.versions.size > MAX_TRACKED_FILE_VERSIONS) {
      const oldest = this.versions.keys().next().value;
      if (oldest === undefined) break;
      this.versions.delete(oldest);
    }
  }
}

/**
 * Whether `absolute` changed since it was last read through this store.
 * `false` when there is no store, the file was never read this turn, or
 * the check itself fails. A file that was read and is now gone counts as
 * changed.
 */
export async function changedSinceRead(
  store: FileReadVersions | undefined,
  absolute: string,
): Promise<boolean> {
  if (store === undefined) return false;
  try {
    const canonical = await canonicalPath(absolute);
    const seen = store.get(canonical);
    if (seen === undefined) return false;
    let size: number;
    try {
      size = (await stat(canonical)).size;
    } catch (err) {
      return isMissing(err);
    }
    if (size !== seen.size) return true;
    const prefix = await readPrefix(canonical, Math.min(size, seen.hashedBytes));
    return hashReadContent(prefix) !== seen.contentHash;
  } catch {
    return false;
  }
}

/**
 * Remember what `absolute` holds right after our own successful write,
 * so the next edit of it is compared against the agent's change and not
 * against the older read. Best effort: a failure leaves the store as it
 * was.
 */
export async function recordOwnWrite(
  store: FileReadVersions | undefined,
  absolute: string,
): Promise<void> {
  if (store === undefined) return;
  try {
    const canonical = await canonicalPath(absolute);
    const size = (await stat(canonical)).size;
    const budget = store.get(canonical)?.hashedBytes ?? FRESHNESS_HASH_BYTES;
    const hashedBytes = Math.min(size, Math.max(budget, FRESHNESS_HASH_BYTES));
    const prefix = await readPrefix(canonical, hashedBytes);
    store.record(canonical, {
      size,
      hashedBytes,
      contentHash: hashReadContent(prefix),
    });
  } catch {
    // The write already landed; a missed update can only cost one
    // unneeded notice later.
  }
}

/**
 * The notice for a result that touched several files (`os.fs.patch`),
 * naming the ones that changed so the model re-reads only those.
 */
export function staleReadNoticeFor(paths: readonly string[]): string {
  if (paths.length === 1) {
    return `note: ${paths[0]} changed since you last read it; re-read it before editing it again.`;
  }
  return `note: these files changed since you last read them: ${paths.join(", ")}; re-read them before editing them again.`;
}

/** Prefix the notice after compression so tail clipping can never drop it. */
export function withStaleReadNotice(
  result: CompressedToolResult,
  changed: boolean,
  notice: string = STALE_READ_NOTICE,
): CompressedToolResult {
  if (!changed) return result;
  return retainToolOutput(
    result,
    {
      ...result,
      summary:
        result.summary.length > 0 ? `${notice}\n${result.summary}` : notice,
      details: { ...result.details, changedSinceRead: true },
    },
    { prefix: `${notice}\n` },
  );
}

/**
 * The same notice on a failed edit: an `oldString` that no longer
 * matches is the most common symptom of a file changed under the model,
 * so the error says why. Only the tool's own errors are annotated; an
 * approval denial or a cancellation passes through untouched.
 */
export function withStaleReadError(err: unknown, changed: boolean, tool: string): unknown {
  if (!changed || !(err instanceof Error)) return err;
  if (!err.message.startsWith(`${tool}:`)) return err;
  return new Error(`${err.message}\n${STALE_READ_NOTICE}`, { cause: err });
}

async function canonicalPath(absolute: string): Promise<string> {
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

async function readPrefix(path: string, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  if (length === 0) return buffer;
  const handle = await open(path, "r");
  try {
    await handle.read(buffer, 0, length, 0);
  } finally {
    await handle.close();
  }
  return buffer;
}

function isMissing(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
