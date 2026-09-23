import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The on-disk shapes behind `FileRestoreStore` (`fs-restore-store.ts`)
 * and the two writers that keep them safe under concurrent use: the
 * atomic JSON write for an index, the exclusive create for a copy.
 */

/** Keeps `<n>-<basename>` under every filesystem's name limit. */
const COPY_BASENAME_MAX = 200;
const KEY_HEX_CHARS = 32;

export interface RestoreCopy {
  /** Monotonic per working directory; the copy's file is `<n>-<basename>`. */
  n: number;
  /** Absolute path of the file whose previous content this is. */
  path: string;
  /** File name of the copy inside the working directory's restore directory. */
  file: string;
  bytes: number;
  lines: number;
  savedAt: number;
  /** The tool whose call replaced the file. */
  tool: string;
  /** The session that made the call — a fusion worker's, in a fan-out. */
  sessionId: string;
}

/** `<root>/<restoreKey>/manifest.json` — one working directory's copy index. */
export interface CopiesManifest {
  version: 2;
  workingDir: string;
  next: number;
  copies: RestoreCopy[];
}

/** `<root>/sessions/<id>.json` — the paths one session created. */
export interface SessionRecord {
  version: 1;
  created: string[];
}

/** The restore directory name for a working directory: 32 hex chars of its sha256. */
export function restoreKey(workingDir: string): string {
  return createHash("sha256")
    .update(resolve(workingDir))
    .digest("hex")
    .slice(0, KEY_HEX_CHARS);
}

/** A session id is `s-<uuid>` today; anything else is made a safe file name. */
export function safeSegment(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length === 0 ? "_" : safe;
}

export function emptyManifest(workingDir: string): CopiesManifest {
  return { version: 2, workingDir: resolve(workingDir), next: 1, copies: [] };
}

/** A manifest a previous build wrote, or a damaged one, never throws — it just remembers less. */
export function normalizeManifest(
  raw: unknown,
  workingDir: string,
): CopiesManifest {
  if (typeof raw !== "object" || raw === null) return emptyManifest(workingDir);
  const record = raw as Partial<CopiesManifest>;
  const copies = Array.isArray(record.copies)
    ? record.copies.filter(isRestoreCopy)
    : [];
  const highest = copies.reduce((max, copy) => Math.max(max, copy.n), 0);
  const next =
    typeof record.next === "number" && Number.isInteger(record.next)
      ? Math.max(record.next, highest + 1)
      : highest + 1;
  return { ...emptyManifest(workingDir), next, copies };
}

export function normalizeSession(raw: unknown): SessionRecord {
  const record = (
    typeof raw === "object" && raw !== null ? raw : {}
  ) as Partial<SessionRecord>;
  const created = Array.isArray(record.created)
    ? record.created.filter((p): p is string => typeof p === "string")
    : [];
  return { version: 1, created };
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
    typeof copy.tool === "string" &&
    typeof copy.sessionId === "string"
  );
}

/** Temp file then rename, so a reader never sees half an index. */
export async function writeJsonAtomically(
  file: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value), "utf8");
  await rename(temp, file);
}

/**
 * Create `<n>-<basename>` with `wx`, bumping `n` past any file already
 * there: a copy another process wrote under the same number (its
 * manifest write raced ours) is never overwritten.
 */
export async function writeCopyExclusively(
  dir: string,
  from: number,
  absolute: string,
  content: Uint8Array | string,
): Promise<{ n: number; file: string }> {
  const name = basename(absolute).slice(0, COPY_BASENAME_MAX);
  for (let n = from; ; n++) {
    const file = `${n}-${name}`;
    try {
      await writeFile(join(dir, file), content, { flag: "wx" });
      return { n, file };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}
