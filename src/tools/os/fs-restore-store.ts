import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * Where a replaced user file's previous content goes, and which files the
 * agent itself created this session.
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
 * Everything lives under `<stateDir>/restore/<sessionId>/`: the copies
 * as `<n>-<basename>` and a small `manifest.json` carrying the copy
 * index and the created-path set. On disk rather than in `SessionState`
 * because the tools consult it BEFORE a write, and a tool sees only its
 * `ToolContext` (working dir, session id) — threading session state into
 * every fs tool would be the invasive change. Keyed by session id, so a
 * resumed session (same id, new process) still knows what it created.
 */

/** Copies kept per session; the oldest is dropped when a new one lands. */
export const RESTORE_COPY_CAP = 20;
/** Largest previous content a copy is taken of. Bigger is announced, not saved. */
export const RESTORE_MAX_BYTES = 5 * 1024 * 1024;
/** Paths remembered as created by the agent; the oldest are forgotten past this. */
const CREATED_PATHS_CAP = 5000;
const MANIFEST_FILE = "manifest.json";
/** Keeps `<n>-<basename>` under every filesystem's name limit. */
const COPY_BASENAME_MAX = 200;

export interface RestoreCopy {
  /** Monotonic per session; the copy's file is `<n>-<basename>`. */
  n: number;
  /** Absolute path of the file whose previous content this is. */
  path: string;
  /** File name of the copy inside the session's restore directory. */
  file: string;
  bytes: number;
  lines: number;
  savedAt: number;
  /** The tool whose call replaced the file. */
  tool: string;
}

interface RestoreManifest {
  version: 1;
  next: number;
  created: string[];
  copies: RestoreCopy[];
}

export class FileRestoreStore {
  constructor(private readonly root: string) {}

  /** `<root>/<sessionId>` — the session's copies and manifest. */
  sessionDir(sessionId: string): string {
    return join(this.root, safeSegment(sessionId));
  }

  /** Did a tool of this session create `absolute` (write to a path that did not exist)? */
  async wasCreated(sessionId: string, absolute: string): Promise<boolean> {
    const manifest = await this.read(sessionId);
    return manifest.created.includes(absolute);
  }

  async recordCreated(sessionId: string, absolute: string): Promise<void> {
    const manifest = await this.read(sessionId);
    if (manifest.created.includes(absolute)) return;
    manifest.created.push(absolute);
    if (manifest.created.length > CREATED_PATHS_CAP) {
      manifest.created.splice(0, manifest.created.length - CREATED_PATHS_CAP);
    }
    await this.write(sessionId, manifest);
  }

  /**
   * Save `content` as the previous content of `absolute`. The caller has
   * checked the size cap; the bytes are stored as given so a restore puts
   * back exactly what was there. Past `RESTORE_COPY_CAP` the oldest copy
   * of the session — whichever path it belonged to — is removed.
   */
  async saveCopy(
    sessionId: string,
    absolute: string,
    content: Uint8Array | string,
    meta: { tool: string; lines: number },
  ): Promise<RestoreCopy> {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });
    const manifest = await this.read(sessionId);
    const n = manifest.next;
    const file = `${n}-${basename(absolute).slice(0, COPY_BASENAME_MAX)}`;
    await writeFile(join(dir, file), content);
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
    };
    manifest.next = n + 1;
    manifest.copies.push(copy);
    while (manifest.copies.length > RESTORE_COPY_CAP) {
      const dropped = manifest.copies.shift();
      if (dropped !== undefined) {
        await rm(join(dir, dropped.file), { force: true });
      }
    }
    await this.write(sessionId, manifest);
    return copy;
  }

  /** The newest saved copy for `absolute`, or null when none was ever taken (or it aged out). */
  async latestCopy(
    sessionId: string,
    absolute: string,
  ): Promise<RestoreCopy | null> {
    const manifest = await this.read(sessionId);
    for (let i = manifest.copies.length - 1; i >= 0; i--) {
      const copy = manifest.copies[i];
      if (copy !== undefined && copy.path === absolute) return copy;
    }
    return null;
  }

  async readCopy(sessionId: string, copy: RestoreCopy): Promise<Buffer> {
    return readFile(join(this.sessionDir(sessionId), copy.file));
  }

  /** Every copy the session still holds, oldest first. */
  async listCopies(sessionId: string): Promise<readonly RestoreCopy[]> {
    return (await this.read(sessionId)).copies;
  }

  private async read(sessionId: string): Promise<RestoreManifest> {
    try {
      const raw = await readFile(
        join(this.sessionDir(sessionId), MANIFEST_FILE),
        "utf8",
      );
      return normalizeManifest(JSON.parse(raw));
    } catch {
      return emptyManifest();
    }
  }

  private async write(
    sessionId: string,
    manifest: RestoreManifest,
  ): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });
    const temp = join(dir, `${MANIFEST_FILE}.${process.pid}.tmp`);
    await writeFile(temp, JSON.stringify(manifest), "utf8");
    await rename(temp, join(dir, MANIFEST_FILE));
  }
}

function emptyManifest(): RestoreManifest {
  return { version: 1, next: 1, created: [], copies: [] };
}

/** A manifest a previous build wrote, or a damaged one, never throws — it just remembers less. */
function normalizeManifest(raw: unknown): RestoreManifest {
  if (typeof raw !== "object" || raw === null) return emptyManifest();
  const record = raw as Partial<RestoreManifest>;
  const created = Array.isArray(record.created)
    ? record.created.filter((p): p is string => typeof p === "string")
    : [];
  const copies = Array.isArray(record.copies)
    ? record.copies.filter(isRestoreCopy)
    : [];
  const highest = copies.reduce((max, copy) => Math.max(max, copy.n), 0);
  const next =
    typeof record.next === "number" && Number.isInteger(record.next)
      ? Math.max(record.next, highest + 1)
      : highest + 1;
  return { version: 1, next, created, copies };
}

function isRestoreCopy(value: unknown): value is RestoreCopy {
  if (typeof value !== "object" || value === null) return false;
  const copy = value as Partial<RestoreCopy>;
  return (
    typeof copy.n === "number" &&
    typeof copy.path === "string" &&
    typeof copy.file === "string" &&
    typeof copy.bytes === "number" &&
    typeof copy.lines === "number" &&
    typeof copy.savedAt === "number" &&
    typeof copy.tool === "string"
  );
}

/** A session id is `s-<uuid>` today; anything else is made a safe directory name. */
function safeSegment(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length === 0 ? "_" : safe;
}
