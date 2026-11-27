import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, rm, stat, statfs } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { copyTreeWithProgress } from "./models-dir-copy.js";

/**
 * Move every downloaded model from one models folder to another
 * (ATO-2106), the way LM Studio's "Change models directory" does.
 *
 * Only folders we own move: a model folder is a non-hidden directory
 * with a `.gguf` (or a `.gguf.part` download) directly inside it. Any
 * other entry of the current folder stays where it is, and the new folder
 * must be empty (a `.DS_Store` aside), so pointing the models folder at
 * ~/Documents can never pull the user's own files along later.
 *
 * Each model folder is renamed when both folders are on the same disk. Across disks a rename
 * fails with `EXDEV`; the entry is then copied, the copy's byte count is
 * checked against the source, and the source is deleted only after
 * `commit` (the caller's config write) has succeeded. A failure before
 * that puts every entry back where it was, so the models are never left
 * split between two folders with the config pointing at one of them.
 *
 * ATO-2503: a copy across disks reports its bytes (`onBytes`), and an
 * aborted `signal` (the CLI on Ctrl+C or the desktop's SIGTERM) stops
 * between two chunks and undoes the move the same way.
 */

export class ModelsDirMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsDirMoveError";
  }
}

export interface ModelsDirMoveProgress {
  /** The model folder (or file) being moved now. */
  entry: string;
  /** 1-based position of `entry`. */
  index: number;
  total: number;
}

/** Bytes of the copy across disks so far (ATO-2503). */
export interface ModelsDirMoveBytes {
  entry: string;
  /** Bytes copied so far, over every model of this move. */
  done: number;
  /** Bytes of every model of this move. */
  total: number;
}

export interface ModelsDirMoveOptions {
  /** Runs once every entry is in the new folder; a throw undoes the move. */
  commit?: () => void | Promise<void>;
  onProgress?: (p: ModelsDirMoveProgress) => void;
  /** Across disks only: the byte count, at most twice a second. */
  onBytes?: (p: ModelsDirMoveBytes) => void;
  /** Aborted: stop, undo what moved, throw. */
  signal?: AbortSignal;
  /** Test seam: `fs.promises.rename`. */
  rename?: (from: string, to: string) => Promise<void>;
  /** Test seam: free bytes at a path (`statfs`). */
  freeBytes?: (path: string) => Promise<number>;
}

export interface ModelsDirMoveResult {
  /** Entries now in the new folder. */
  moved: string[];
  /** Entries of the current folder that are not model folders; left in place. */
  skipped: string[];
  /** Copied entries whose original could not be deleted afterwards. */
  leftovers: string[];
}

/** True when `child` is `parent` or somewhere below it. */
export function isSameOrInside(child: string, parent: string): boolean {
  const caseless = process.platform === "darwin" || process.platform === "win32";
  const a = caseless ? child.toLowerCase() : child;
  const b = caseless ? parent.toLowerCase() : parent;
  const rel = relative(b, a);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The real path of `p`, resolving only the part of it that exists. */
async function realOrNearest(p: string): Promise<string> {
  const rest: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      return join(await realpath(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** Bytes of every file under `p` (symlinks counted as links, not followed). */
export async function treeBytes(p: string): Promise<number> {
  const st = await lstat(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of await readdir(p)) total += await treeBytes(join(p, name));
  return total;
}

async function defaultFreeBytes(path: string): Promise<number> {
  const s = await statfs(path);
  return s.bavail * s.bsize;
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Names an OS drops into any folder; they do not make a folder "not empty". */
const IGNORED_IN_TARGET = new Set([".DS_Store"]);

/** A model folder we wrote: non-hidden directory with a GGUF (or GGUF download) in it. */
export async function isOwnedModelEntry(dir: string, name: string): Promise<boolean> {
  if (name.startsWith(".")) return false;
  const p = join(dir, name);
  try {
    if (!(await lstat(p)).isDirectory()) return false;
    return (await readdir(p)).some((f) => /\.gguf(\.part)?$/i.test(f));
  } catch {
    return false;
  }
}

type Done = { entry: string; how: "renamed" | "copied" };

export async function moveModelsDir(
  from: string,
  to: string,
  opts: ModelsDirMoveOptions = {},
): Promise<ModelsDirMoveResult> {
  const doRename = opts.rename ?? rename;
  const src = resolve(from);
  const dst = resolve(to);
  const realSrc = await realOrNearest(src);
  const realDst = await realOrNearest(dst);
  if (isSameOrInside(realDst, realSrc) && isSameOrInside(realSrc, realDst)) {
    await opts.commit?.();
    return { moved: [], skipped: [], leftovers: [] };
  }
  if (isSameOrInside(realDst, realSrc)) {
    throw new ModelsDirMoveError(`the new folder ${dst} is inside the current models folder ${src}`);
  }
  if (isSameOrInside(realSrc, realDst)) {
    throw new ModelsDirMoveError(`the current models folder ${src} is inside the new folder ${dst}; pick an empty or separate folder`);
  }

  if (existsSync(dst)) {
    const present = (await readdir(dst)).filter((e) => !IGNORED_IN_TARGET.has(e));
    if (present.length > 0) {
      throw new ModelsDirMoveError(`the new folder ${dst} is not empty; pick an empty folder or a new one`);
    }
  }
  const all = existsSync(src) ? (await readdir(src)).sort() : [];
  const entries: string[] = [];
  const skipped: string[] = [];
  for (const e of all) {
    if (await isOwnedModelEntry(src, e)) entries.push(e);
    else if (!IGNORED_IN_TARGET.has(e)) skipped.push(e);
  }
  await mkdir(dst, { recursive: true });

  // Across disks every byte is copied before any source is deleted, so the
  // new disk needs room for all of it.
  const crossDisk = entries.length > 0 && (await stat(src)).dev !== (await stat(dst)).dev;
  let need = 0;
  if (crossDisk) {
    for (const e of entries) need += await treeBytes(join(src, e));
    const free = await (opts.freeBytes ?? defaultFreeBytes)(dst);
    if (free < need) {
      throw new ModelsDirMoveError(
        `not enough free space in ${dst}: ${(need / 1e9).toFixed(1)} GB needed, ${(free / 1e9).toFixed(1)} GB free`,
      );
    }
  }

  const done: Done[] = [];
  const rollBack = async (): Promise<void> => {
    for (const d of [...done].reverse()) {
      try {
        if (d.how === "renamed") await doRename(join(dst, d.entry), join(src, d.entry));
        else await rm(join(dst, d.entry), { recursive: true, force: true });
      } catch {
        /* best effort: the entry stays in the new folder */
      }
    }
  };

  let copiedBefore = 0;
  for (const [i, entry] of entries.entries()) {
    if (opts.signal?.aborted) {
      await rollBack();
      throw new ModelsDirMoveError("the move was stopped; every model is back in the old folder");
    }
    opts.onProgress?.({ entry, index: i + 1, total: entries.length });
    const a = join(src, entry);
    const b = join(dst, entry);
    try {
      await doRename(a, b);
      done.push({ entry, how: "renamed" });
      continue;
    } catch (err) {
      if (errCode(err) !== "EXDEV") {
        await rollBack();
        throw new ModelsDirMoveError(`could not move ${entry}: ${message(err)}`);
      }
    }
    try {
      // `stat` saw one disk but the rename still said EXDEV (a bind mount): size it now.
      if (need === 0) for (const e of entries) need += await treeBytes(join(src, e));
      const base = copiedBefore;
      await copyTreeWithProgress(a, b, {
        signal: opts.signal,
        onBytes: (n) => opts.onBytes?.({ entry, done: base + n, total: need }),
      });
      const [want, got] = [await treeBytes(a), await treeBytes(b)];
      if (want !== got) throw new Error(`copy has ${got} bytes, expected ${want}`);
      copiedBefore += want;
      done.push({ entry, how: "copied" });
    } catch (err) {
      await rm(b, { recursive: true, force: true }).catch(() => {});
      await rollBack();
      if (opts.signal?.aborted) throw new ModelsDirMoveError("the move was stopped; every model is back in the old folder");
      throw new ModelsDirMoveError(`could not copy ${entry}: ${message(err)}`);
    }
  }

  try {
    await opts.commit?.();
  } catch (err) {
    await rollBack();
    throw err;
  }

  const leftovers: string[] = [];
  for (const d of done) {
    if (d.how !== "copied") continue;
    try {
      await rm(join(src, d.entry), { recursive: true, force: true });
    } catch {
      leftovers.push(join(src, d.entry));
    }
  }
  return { moved: done.map((d) => d.entry), skipped, leftovers };
}
