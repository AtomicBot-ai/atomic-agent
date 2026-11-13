import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeSegment, writeJsonAtomically } from "./fs-restore-manifest.js";

/**
 * File checkpoints for "roll back here" (ATO-1056): before one of the
 * agent's file tools changes a file, what the file held (or that it did
 * not exist) is saved here, per session, with the time it was taken.
 *
 * Time, not a turn number, ties a copy to the chat: a turn's question is
 * stamped when the turn starts (`userTurn`), and every tool call of that
 * turn runs after it, so "the files as they were before question N" is
 * the earliest copy of each path taken at or after question N's `at`.
 * The tools see only `ToolContext` (session id, working dir), so no turn
 * index has to be threaded through the loop.
 *
 * Not `FileRestoreStore` (`fs-restore-store.ts`): that one keeps the last
 * 20 replaced files of a working directory for `os.fs.restore`; this one
 * keeps every change of one session, in order, so a chat can be taken
 * back to any of its questions.
 *
 * Bounded: a file over {@link CHECKPOINT_MAX_FILE_BYTES} or one that looks
 * binary is recorded as changed but not copied (the rollback says it
 * cannot put it back); past {@link CHECKPOINT_MAX_ENTRIES} entries or
 * {@link CHECKPOINT_MAX_SESSION_BYTES} of copies the oldest are dropped,
 * and `droppedThrough` remembers how far, so a rollback to a point
 * older than that says some changes are no longer kept. Session folders
 * untouched for {@link CHECKPOINT_MAX_AGE_MS} are removed the first time
 * a store captures anything.
 *
 * Layout: `<root>/<session>/index.json` plus one `<n>.bin` per copy.
 * Writes of one session's index are serialised in-process; two
 * processes on one state dir are last-writer-wins on the index, as with
 * the restore store.
 */

export const CHECKPOINT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const CHECKPOINT_MAX_SESSION_BYTES = 64 * 1024 * 1024;
export const CHECKPOINT_MAX_ENTRIES = 400;
export const CHECKPOINT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Bytes scanned for a NUL to call a file binary. */
const BINARY_SNIFF_BYTES = 8000;
const INDEX_FILE = "index.json";

/** Why a changed file was recorded without a copy. */
export type CheckpointSkip = "too_large" | "binary" | "not_a_file" | "unreadable";

export interface CheckpointEntry {
  /** Monotonic per session; the copy is `<n>.bin`. */
  n: number;
  /** Absolute path of the file the tool was about to change. */
  path: string;
  /** When the copy was taken (epoch ms). */
  at: number;
  /** The tool that was about to change it. */
  tool: string;
  /** The path existed before the change. */
  existed: boolean;
  /** The copy's file name, when one was taken. */
  file?: string;
  bytes?: number;
  /** sha256 of the saved content, to tell an unchanged file from a changed one. */
  sha256?: string;
  /** Set when the path existed but no copy was taken. */
  skipped?: CheckpointSkip;
}

interface CheckpointIndex {
  version: 1;
  next: number;
  totalBytes: number;
  /** The newest `at` of a dropped entry; 0 when nothing was dropped. */
  droppedThrough: number;
  entries: CheckpointEntry[];
}

export interface CheckpointsSince {
  /** Entries taken at or after the time asked for, oldest first. */
  entries: CheckpointEntry[];
  /** Some entries from that time on were dropped to stay in bounds. */
  incomplete: boolean;
}

/** Where the runtime keeps them: `<stateDir>/file-checkpoints`. */
export function fileCheckpointsRoot(stateDir: string): string {
  return join(stateDir, "file-checkpoints");
}

export function sha256Of(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function looksBinary(content: Uint8Array): boolean {
  const end = Math.min(content.byteLength, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (content[i] === 0) return true;
  return false;
}

export class FileCheckpointStore {
  private readonly chains = new Map<string, Promise<void>>();
  private pruned = false;

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  sessionDir(sessionId: string): string {
    return join(this.root, safeSegment(sessionId));
  }

  /**
   * Record what `absolute` holds now, before a tool changes it. Never
   * throws: a checkpoint that cannot be taken must not stop the tool.
   */
  async capture(sessionId: string, absolute: string, tool: string): Promise<void> {
    try {
      if (!this.pruned) {
        this.pruned = true;
        await this.pruneOld();
      }
      const at = this.now();
      const before = await readBefore(absolute);
      await this.serialised(sessionId, async () => {
        const dir = this.sessionDir(sessionId);
        await mkdir(dir, { recursive: true });
        const index = await this.readIndex(sessionId);
        const n = index.next;
        const entry: CheckpointEntry = { n, path: absolute, at, tool, existed: before.existed };
        if (before.skipped !== undefined) entry.skipped = before.skipped;
        if (before.content !== undefined) {
          entry.file = `${n}.bin`;
          entry.bytes = before.content.byteLength;
          entry.sha256 = sha256Of(before.content);
          await writeFile(join(dir, entry.file), before.content);
          index.totalBytes += entry.bytes;
        }
        index.next = n + 1;
        index.entries.push(entry);
        await this.trim(dir, index);
        await writeJsonAtomically(join(dir, INDEX_FILE), index);
      });
    } catch {
      // Best effort by design (see above).
    }
  }

  /** The entries taken at or after `at`, oldest first. */
  async since(sessionId: string, at: number): Promise<CheckpointsSince> {
    const index = await this.readIndex(sessionId);
    return {
      entries: index.entries.filter((entry) => entry.at >= at),
      incomplete: index.droppedThrough >= at,
    };
  }

  async readCopy(sessionId: string, entry: CheckpointEntry): Promise<Buffer> {
    if (entry.file === undefined) throw new Error(`no copy kept of ${entry.path}`);
    return readFile(join(this.sessionDir(sessionId), entry.file));
  }

  /**
   * Forget the entries taken at or after `at`: the turns they belong to
   * were removed from the chat, so no later rollback can point at them.
   */
  async dropSince(sessionId: string, at: number): Promise<void> {
    await this.serialised(sessionId, async () => {
      const dir = this.sessionDir(sessionId);
      const index = await this.readIndex(sessionId);
      const kept: CheckpointEntry[] = [];
      for (const entry of index.entries) {
        if (entry.at < at) {
          kept.push(entry);
          continue;
        }
        if (entry.file !== undefined) await rm(join(dir, entry.file), { force: true });
        index.totalBytes -= entry.bytes ?? 0;
      }
      if (kept.length === index.entries.length) return;
      index.entries = kept;
      index.totalBytes = Math.max(0, index.totalBytes);
      await writeJsonAtomically(join(dir, INDEX_FILE), index);
    });
  }

  async removeSession(sessionId: string): Promise<void> {
    await rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  private async trim(dir: string, index: CheckpointIndex): Promise<void> {
    while (
      index.entries.length > CHECKPOINT_MAX_ENTRIES ||
      (index.totalBytes > CHECKPOINT_MAX_SESSION_BYTES && index.entries.length > 1)
    ) {
      const dropped = index.entries.shift();
      if (dropped === undefined) break;
      if (dropped.file !== undefined) await rm(join(dir, dropped.file), { force: true });
      index.totalBytes = Math.max(0, index.totalBytes - (dropped.bytes ?? 0));
      index.droppedThrough = Math.max(index.droppedThrough, dropped.at);
    }
  }

  private async pruneOld(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return;
    }
    const cutoff = this.now() - CHECKPOINT_MAX_AGE_MS;
    for (const name of names) {
      const dir = join(this.root, name);
      try {
        const info = await stat(join(dir, INDEX_FILE));
        if (info.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true });
      } catch {
        // Not a session folder, or already gone.
      }
    }
  }

  private async readIndex(sessionId: string): Promise<CheckpointIndex> {
    try {
      const raw = await readFile(join(this.sessionDir(sessionId), INDEX_FILE), "utf8");
      return normalizeIndex(JSON.parse(raw));
    } catch {
      return { version: 1, next: 1, totalBytes: 0, droppedThrough: 0, entries: [] };
    }
  }

  private async serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    }
  }
}

interface Before {
  existed: boolean;
  content?: Buffer;
  skipped?: CheckpointSkip;
}

async function readBefore(absolute: string): Promise<Before> {
  let info: Stats;
  try {
    info = await stat(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { existed: false };
    return { existed: true, skipped: "unreadable" };
  }
  if (!info.isFile()) return { existed: true, skipped: "not_a_file" };
  if (info.size > CHECKPOINT_MAX_FILE_BYTES) return { existed: true, skipped: "too_large" };
  let content: Buffer;
  try {
    content = await readFile(absolute);
  } catch {
    return { existed: true, skipped: "unreadable" };
  }
  if (content.byteLength > CHECKPOINT_MAX_FILE_BYTES) return { existed: true, skipped: "too_large" };
  if (looksBinary(content)) return { existed: true, skipped: "binary" };
  return { existed: true, content };
}

function normalizeIndex(raw: unknown): CheckpointIndex {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<CheckpointIndex>;
  const entries = Array.isArray(record.entries) ? record.entries.filter(isEntry) : [];
  const highest = entries.reduce((max, entry) => Math.max(max, entry.n), 0);
  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    version: 1,
    next: Math.max(num(record.next), highest + 1),
    totalBytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
    droppedThrough: num(record.droppedThrough),
    entries,
  };
}

function isEntry(value: unknown): value is CheckpointEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<CheckpointEntry>;
  return (
    typeof entry.n === "number" &&
    typeof entry.path === "string" &&
    typeof entry.at === "number" &&
    typeof entry.tool === "string" &&
    typeof entry.existed === "boolean"
  );
}
