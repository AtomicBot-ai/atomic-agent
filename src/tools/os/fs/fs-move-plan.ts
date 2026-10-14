import * as fsPromises from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveUserPath } from "../expand-home.js";
import type { MoveItem } from "./fs-move-contract.js";

/**
 * The filesystem calls a move makes. Injected so a test can stand in a
 * second volume (`rename` failing with EXDEV) without one; production
 * passes `node:fs/promises` itself.
 */
export type MoveFs = Pick<
  typeof fsPromises,
  "lstat" | "realpath" | "rename" | "cp" | "rm" | "mkdir"
>;

export const NODE_MOVE_FS: MoveFs = fsPromises;

/** One checked move: where it starts, where it lands, what it replaces. */
export interface PlannedMove {
  /** As the call spelled it. */
  from: string;
  to: string;
  /** Absolute. */
  source: string;
  /** Absolute, after "inside the folder" resolution. */
  dest: string;
  folder: boolean;
  /** An existing file at `dest` is replaced (only with `overwrite: true`). */
  replaces: boolean;
}

export interface PlanOptions {
  workingDir: string;
  overwrite: boolean;
  fs: MoveFs;
  /** Test seam for the trailing-backslash rule. */
  platform?: NodeJS.Platform;
}

/**
 * A `to` that ends in a separator names a folder to move INTO. A
 * backslash is a separator only on Windows; elsewhere it is a legal (if
 * odd) file-name character.
 */
export function namesFolder(
  rawTo: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return rawTo.endsWith("/") || (platform === "win32" && rawTo.endsWith("\\"));
}

/** `child` lies strictly under `parent`. */
export function isStrictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function fail(message: string): never {
  throw new Error(`os.fs.move: ${message}`);
}

async function lstatOrNull(fs: MoveFs, path: string): Promise<Stats | null> {
  try {
    return await fs.lstat(path);
  } catch {
    return null;
  }
}

async function realpathOrNull(fs: MoveFs, path: string): Promise<string | null> {
  try {
    return await fs.realpath(path);
  } catch {
    return null;
  }
}

/** Realpath of the deepest existing ancestor, with the missing suffix re-attached. */
async function canonicalLanding(fs: MoveFs, path: string): Promise<string> {
  let current = path;
  const suffix: string[] = [];
  for (;;) {
    const real = await realpathOrNull(fs, current);
    if (real !== null) return join(real, ...suffix.reverse());
    const parent = dirname(current);
    if (parent === current) return path;
    suffix.push(basename(current));
    current = parent;
  }
}

/**
 * Two spellings of one existing entry: the case-only rename of a
 * case-insensitive disk, and nothing else. The spellings must differ
 * only in case (so two hard links never count — renaming one onto the
 * other is a silent no-op), and the entry ids must match, compared as
 * bigints: an NTFS file id is 64 bits and loses its low bits as a JS
 * number. A FAT disk reports no ids at all; there, equal-ignoring-case
 * is the same entry by definition.
 */
export async function sameEntry(
  fs: MoveFs,
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (a === b) return true;
  if (platform !== "win32" && platform !== "darwin") return false;
  if (a.toLowerCase() !== b.toLowerCase()) return false;
  try {
    const [sa, sb] = await Promise.all([
      fs.lstat(a, { bigint: true }),
      fs.lstat(b, { bigint: true }),
    ]);
    if (sa.ino === 0n && sb.ino === 0n) return true;
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

async function planOne(item: MoveItem, options: PlanOptions): Promise<PlannedMove> {
  const { fs, workingDir, overwrite } = options;
  const platform = options.platform ?? process.platform;
  // `resolve` on top: an absolute input comes back from resolveUserPath
  // as typed, and `/w/./a`, `/w/a/` or `/w//a` must compare, key the
  // restore copy and undo as `/w/a`.
  const source = resolve(resolveUserPath(item.from, workingDir));
  const sourceInfo = await lstatOrNull(fs, source);
  if (sourceInfo === null) fail(`nothing at \`${item.from}\` (${source})`);
  const folder = sourceInfo.isDirectory();

  const target = resolve(resolveUserPath(item.to, workingDir));
  let dest = target;
  if (namesFolder(item.to, options.platform)) {
    dest = join(target, basename(source));
  } else {
    const targetInfo = await lstatOrNull(fs, target);
    if (targetInfo?.isDirectory() && !(await sameEntry(fs, source, target, platform))) {
      dest = join(target, basename(source));
    }
  }
  if (dest === source) {
    fail(`\`${item.from}\` is already at \`${item.to}\` — nothing to move`);
  }

  let replaces = false;
  const destInfo = await lstatOrNull(fs, dest);
  if (destInfo !== null && !(await sameEntry(fs, source, dest, platform))) {
    if (!destInfo.isFile()) {
      fail(`\`${dest}\` already exists and is not a file; it is never replaced — pick another name or os.fs.trash it first`);
    }
    if (folder) fail(`will not replace the file \`${dest}\` with the folder \`${item.from}\``);
    if (!overwrite) {
      fail(`\`${dest}\` already exists — pass overwrite: true only if the user wants it replaced, or pick another name`);
    }
    replaces = true;
  }

  if (folder) {
    const realSource = (await realpathOrNull(fs, source)) ?? source;
    const landing = await canonicalLanding(fs, dest);
    if (isStrictlyInside(source, dest) || isStrictlyInside(realSource, landing)) {
      fail(`cannot move the folder \`${item.from}\` into itself (\`${dest}\`)`);
    }
  }
  return { from: item.from, to: item.to, source, dest, folder, replaces };
}

/** Case-insensitive where the usual disks are, so `A.txt` and `a.txt` collide there. */
function collisionKey(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" || platform === "darwin" ? path.toLowerCase() : path;
}

/**
 * Moves whose outcome would depend on their order are refused as a
 * whole, so a batch either runs as written or not at all.
 */
function checkBatch(moves: readonly PlannedMove[], platform: NodeJS.Platform): void {
  const dests = new Map<string, PlannedMove>();
  for (const move of moves) {
    const key = collisionKey(move.dest, platform);
    const earlier = dests.get(key);
    if (earlier !== undefined) {
      fail(`\`${earlier.from}\` and \`${move.from}\` would both land at \`${move.dest}\` — end \`to\` with / to move an item INTO a folder`);
    }
    dests.set(key, move);
  }
  if (moves.length < 2) return;
  const key = (path: string) => collisionKey(path, platform);
  for (const a of moves) {
    for (const b of moves) {
      if (a === b) continue;
      if (key(a.source) === key(b.source)) {
        fail(`\`${a.from}\` is listed twice`);
      }
      if (a.folder && isStrictlyInside(key(a.source), key(b.source))) {
        fail(`\`${b.from}\` is inside \`${a.from}\`, which this call also moves — move the folder or its contents, not both`);
      }
      if (a.folder && isStrictlyInside(key(a.source), key(b.dest))) {
        fail(`\`${b.to}\` is inside \`${a.from}\`, which this call moves away — split this into two calls`);
      }
      if (key(a.source) === key(b.dest)) {
        fail(`\`${a.from}\` is both moved and moved onto — split this into two calls`);
      }
      // `Docs/` for one item and `Docs` for another: the second is a
      // rename to a file called Docs, and whichever runs later fails.
      if (isStrictlyInside(key(a.dest), key(b.dest))) {
        fail(`\`${a.to}\` is both a destination and a folder another item lands in — end \`to\` with / to move an item INTO a folder`);
      }
    }
  }
}

/** Check every move before anything is asked or touched. Throws on the first problem. */
export async function planMoves(
  items: readonly MoveItem[],
  options: PlanOptions,
): Promise<PlannedMove[]> {
  const moves: PlannedMove[] = [];
  for (const item of items) moves.push(await planOne(item, options));
  checkBatch(moves, options.platform ?? process.platform);
  return moves;
}
