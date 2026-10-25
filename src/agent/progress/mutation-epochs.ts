/**
 * Mutation-attempt epochs for the read loop gate (ATO-1000, #827).
 *
 * The no-progress streak keys on `(tool, args)` plus the result, so five
 * identical `os.fs.read` calls returning the same text are a loop. That
 * is right for a model re-reading a file it is not doing anything with,
 * and wrong for the recovery a failed edit asks for: `os.fs.edit` throws
 * before it writes when `oldString` does not match, the file keeps its
 * bytes, and the re-read that shows the model the exact text returns what
 * the previous read returned. Each cycle added one to the streak, the
 * fifth re-read was vetoed, and the turn could neither read nor edit.
 *
 * A write, edit, patch, move or restore that was ATTEMPTED on a path --
 * landed or not -- is the event that makes a re-read of that path worth
 * having, so it opens a new epoch for the path. A read is tagged with the
 * epoch it was made in, and the repeat and no-progress counters only
 * compare reads of one epoch. Reading the same file over and over with
 * nothing tried in between stays in one epoch and is caught as before;
 * an edit that keeps failing the same way is caught by its own streak.
 */

/** Tools whose attempt opens a new read epoch for the paths they target. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.write",
  "os.fs.edit",
  "os.fs.patch",
  "os.fs.restore",
  "os.fs.move",
]);

/** Cap on paths tracked in one turn; the least recently touched goes first. */
const MAX_TRACKED_PATHS = 200;

/**
 * A path as the model wrote it, made comparable: separators unified,
 * `.` segments and repeated separators dropped, case folded (Windows
 * paths are case-insensitive, and a looser match can only cost a
 * detection, never cause a false one). `..` is kept as written.
 */
export function normalizeLoopPath(raw: string): string {
  const segments = raw
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment, index) => segment !== "." && (segment !== "" || index === 0));
  return segments.join("/").toLowerCase();
}

/**
 * Do two normalized paths name the same file? Equal, or one is the other
 * with leading directories: a relative `src/a.ts` in an edit and the
 * resolved `/repo/src/a.ts` a read reports are one file. Matching on
 * whole segments keeps `a.ts` from matching `data.ts`.
 */
export function samePathTarget(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === "" || b === "") return false;
  return a.length < b.length ? b.endsWith(`/${a}`) : a.endsWith(`/${b}`);
}

/** The path an `os.fs.read` call reads, normalized, or `null`. */
export function readTargetPath(tool: string, args: unknown): string | null {
  if (tool !== "os.fs.read") return null;
  const path = stringField(args, "path");
  return path === null ? null : normalizeLoopPath(path);
}

/**
 * The paths a mutating call targets, normalized: `"any"` when the call
 * names its files somewhere the tracker does not parse (a patch body),
 * `null` for a call that mutates nothing.
 */
export function mutationTargets(
  tool: string,
  args: unknown,
): readonly string[] | "any" | null {
  if (!MUTATING_TOOLS.has(tool)) return null;
  if (tool === "os.fs.patch") return "any";
  const raw: string[] = [];
  for (const key of ["path", "from", "to"]) {
    const value = stringField(args, key);
    if (value !== null) raw.push(value);
  }
  const moves =
    args !== null && typeof args === "object"
      ? (args as Record<string, unknown>).moves
      : undefined;
  if (Array.isArray(moves)) {
    for (const move of moves) {
      for (const key of ["from", "to"]) {
        const value = stringField(move, key);
        if (value !== null) raw.push(value);
      }
    }
  }
  return raw.length === 0 ? "any" : raw.map(normalizeLoopPath);
}

/**
 * Per-turn epoch book. Epochs are sequence numbers of the latest attempt
 * that touched a path, so they only ever grow for a given path.
 */
export class MutationEpochs {
  private seq = 0;
  private anySeq = 0;
  private readonly latest = new Map<string, number>();

  /**
   * Fold a completed (non-vetoed) call in. Returns what it touched, so
   * the caller can reset its own per-path state, or `null`.
   */
  note(tool: string, args: unknown): readonly string[] | "any" | null {
    const targets = mutationTargets(tool, args);
    if (targets === null) return null;
    this.seq += 1;
    if (targets === "any") {
      this.anySeq = this.seq;
      return targets;
    }
    for (const path of targets) {
      this.latest.delete(path);
      this.latest.set(path, this.seq);
    }
    while (this.latest.size > MAX_TRACKED_PATHS) {
      const oldest = this.latest.keys().next();
      if (oldest.done) break;
      this.latest.delete(oldest.value);
    }
    return targets;
  }

  /** The epoch a read of `path` (normalized) is made in now. */
  epochFor(path: string): number {
    let epoch = this.anySeq;
    for (const [touched, seq] of this.latest) {
      if (seq > epoch && samePathTarget(touched, path)) epoch = seq;
    }
    return epoch;
  }
}

function stringField(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object") return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}
