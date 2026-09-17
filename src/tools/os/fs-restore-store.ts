import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  emptyManifest,
  normalizeManifest,
  normalizeSession,
  restoreKey,
  safeSegment,
  writeCopyExclusively,
  writeJsonAtomically,
  type CopiesManifest,
  type RestoreCopy,
  type SessionRecord,
} from "./fs-restore-manifest.js";

export { restoreKey, type RestoreCopy } from "./fs-restore-manifest.js";

/**
 * Where a replaced user file's previous content goes, and which files
 * the agent itself created this session.
 *
 * Two live failures motivate this (Gemma 4 31B, 2026-09-15): the model's
 * first step wrote `projects.json` over the user's data file without
 * listing the folder — the result said "(replace)" and the model did not
 * react — and after a corrupted listing it wrote a 9-row `sales.csv` over
 * the user's 2,401-row dataset. Both were named by the request as inputs;
 * both were unrecoverable afterwards. Warn-only by design: the write
 * still lands, but its previous content is saved first and the result
 * says so, loudly when the replacement looks like a loss.
 *
 * Two keys, because the two facts have different owners (F43):
 *
 *  - The COPIES are keyed by WORKING DIRECTORY. `<root>/<key>/` holds
 *    them as `<n>-<basename>` plus a `manifest.json` (the copy index,
 *    and the directory's path for a human reading the folder), where
 *    `key` is the first 32 hex chars of the sha256 of the absolute
 *    working directory (`restoreKey`). F36 keyed them by session id, and
 *    a fusion worker is its own ephemeral session: the worker that
 *    overwrote `sales.csv` saved the original under ITS session, and the
 *    later worker sent to restore it — a different session — found
 *    nothing. Any session on the same working directory (the
 *    orchestrator, a worker of any fan-out, a resumed session) now
 *    restores it.
 *  - The CREATED set stays per session, at `<root>/sessions/<id>.json`:
 *    "the agent made this file" is a fact about the session that made
 *    it, so another session's replacement of that file is still
 *    announced.
 *
 * On disk rather than in `SessionState` because the tools consult it
 * BEFORE a write, and a tool sees only its `ToolContext` (working dir,
 * session id). F36's per-session directories are simply not consulted
 * any more; nothing is migrated.
 *
 * Concurrent writers are the normal case now — the workers of one
 * fan-out share a manifest — so every read-modify-write of one index is
 * serialised in-process, and a copy file is created exclusively (`wx`),
 * its number bumped past anything another process left. A manifest two
 * processes write at the same instant is last-writer-wins: the loser's
 * copy file survives on disk, only its index entry is lost.
 */

/** Copies kept per working directory; the oldest is dropped when a new one lands. */
export const RESTORE_COPY_CAP = 20;
/** Largest previous content a copy is taken of. Bigger is announced, not saved. */
export const RESTORE_MAX_BYTES = 5 * 1024 * 1024;
/** Paths remembered as created by a session; the oldest are forgotten past this. */
const CREATED_PATHS_CAP = 5000;
const MANIFEST_FILE = "manifest.json";
const SESSIONS_DIR = "sessions";

export class FileRestoreStore {
  /** One in-flight read-modify-write per index (see `serialised`). */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  /** `<root>/<restoreKey(workingDir)>` — the working directory's copies and manifest. */
  copiesDir(workingDir: string): string {
    return join(this.root, restoreKey(workingDir));
  }

  /** `<root>/sessions/<sessionId>.json` — the paths this session created. */
  sessionFile(sessionId: string): string {
    return join(this.root, SESSIONS_DIR, `${safeSegment(sessionId)}.json`);
  }

  /** Did a tool of this session create `absolute` (write to a path that did not exist)? */
  async wasCreated(sessionId: string, absolute: string): Promise<boolean> {
    return (await this.readSession(sessionId)).created.includes(absolute);
  }

  async recordCreated(sessionId: string, absolute: string): Promise<void> {
    await this.serialised(`session:${sessionId}`, async () => {
      const record = await this.readSession(sessionId);
      if (record.created.includes(absolute)) return;
      record.created.push(absolute);
      if (record.created.length > CREATED_PATHS_CAP) {
        record.created.splice(0, record.created.length - CREATED_PATHS_CAP);
      }
      await writeJsonAtomically(this.sessionFile(sessionId), record);
    });
  }

  /**
   * Save `content` as the previous content of `absolute`, a file under
   * (or reached from) `workingDir`. The caller has checked the size cap;
   * the bytes are stored as given so a restore puts back exactly what
   * was there. Past `RESTORE_COPY_CAP` the oldest copy of the working
   * directory — whichever path or session it belonged to — is removed.
   */
  async saveCopy(
    workingDir: string,
    absolute: string,
    content: Uint8Array | string,
    meta: { tool: string; lines: number; sessionId: string },
  ): Promise<RestoreCopy> {
    const dir = this.copiesDir(workingDir);
    return this.serialised(`copies:${dir}`, async () => {
      await mkdir(dir, { recursive: true });
      const manifest = await this.readManifest(workingDir);
      const { n, file } = await writeCopyExclusively(
        dir,
        manifest.next,
        absolute,
        content,
      );
      const copy: RestoreCopy = {
        n,
        path: absolute,
        file,
        bytes:
          typeof content === "string"
            ? Buffer.byteLength(content, "utf8")
            : content.byteLength,
        lines: meta.lines,
        savedAt: Date.now(),
        tool: meta.tool,
        sessionId: meta.sessionId,
      };
      manifest.next = n + 1;
      manifest.copies.push(copy);
      while (manifest.copies.length > RESTORE_COPY_CAP) {
        const dropped = manifest.copies.shift();
        if (dropped !== undefined) {
          await rm(join(dir, dropped.file), { force: true });
        }
      }
      await writeJsonAtomically(join(dir, MANIFEST_FILE), manifest);
      return copy;
    });
  }

  /** The newest saved copy for `absolute`, or null when none was ever taken (or it aged out). */
  async latestCopy(
    workingDir: string,
    absolute: string,
  ): Promise<RestoreCopy | null> {
    const manifest = await this.readManifest(workingDir);
    for (let i = manifest.copies.length - 1; i >= 0; i--) {
      const copy = manifest.copies[i];
      if (copy !== undefined && copy.path === absolute) return copy;
    }
    return null;
  }

  async readCopy(workingDir: string, copy: RestoreCopy): Promise<Buffer> {
    return readFile(join(this.copiesDir(workingDir), copy.file));
  }

  /** Every copy the working directory still holds, oldest first. */
  async listCopies(workingDir: string): Promise<readonly RestoreCopy[]> {
    return (await this.readManifest(workingDir)).copies;
  }

  private async readManifest(workingDir: string): Promise<CopiesManifest> {
    try {
      const raw = await readFile(
        join(this.copiesDir(workingDir), MANIFEST_FILE),
        "utf8",
      );
      return normalizeManifest(JSON.parse(raw), workingDir);
    } catch {
      return emptyManifest(workingDir);
    }
  }

  private async readSession(sessionId: string): Promise<SessionRecord> {
    try {
      const raw = await readFile(this.sessionFile(sessionId), "utf8");
      return normalizeSession(JSON.parse(raw));
    } catch {
      return { version: 1, created: [] };
    }
  }

  /**
   * Run `fn` after every earlier call made under `key` has settled. The
   * workers of one fan-out replace files at the same time into the same
   * manifest; two unserialised read-modify-writes would each see `next`
   * = 5 and one would lose its entry.
   */
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
