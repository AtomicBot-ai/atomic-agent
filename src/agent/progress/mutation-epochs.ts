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
 * A write, edit, applied patch, move or restore ATTEMPTED on a path --
 * landed or not -- is the event that makes a re-read of that path worth
 * having, so it opens a new epoch for the path. A patch dry run changes
 * nothing and opens none. A read is tagged with the epoch it was made in,
 * and the repeat and no-progress counters only compare reads of one epoch.
 *
 * Failed attempts open epochs only up to `MAX_FAILED_EPOCHS` in a row per
 * path; after that the path stays in its epoch until a change lands, so a
 * model alternating identical re-reads with ever-different failing edits
 * is vetoed on the re-reads again. Still caught as before: re-reading with
 * nothing tried in between, re-reading while only other files are edited,
 * and an edit that keeps failing the same way (its own streak).
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
 * Consecutive failed attempts on one path that still open a new epoch.
 * Three failed edits each followed by a re-read is ordinary recovery; a
 * fourth with no change landed is the edit side of a loop.
 */
export const MAX_FAILED_EPOCHS = 3;

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
 * names its files somewhere the tracker does not parse (a `patchPath`, a
 * diff without readable headers), `null` for a call that mutates nothing
 * -- including a patch dry run (`apply` is not `true`).
 */
export function mutationTargets(
  tool: string,
  args: unknown,
): readonly string[] | "any" | null {
  if (!MUTATING_TOOLS.has(tool)) return null;
  if (tool === "os.fs.patch") return patchTargets(args);
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
 * Files an applied patch touches, read from its `---` / `+++` headers
 * with `stripComponents` (default 1, as the tool) dropped and `rootDir`
 * prefixed. `"any"` when they cannot be read; `null` for a dry run.
 */
function patchTargets(args: unknown): readonly string[] | "any" | null {
  if (args === null || typeof args !== "object") return "any";
  const record = args as Record<string, unknown>;
  if (record.apply !== true) return null;
  const patch = stringField(args, "patch");
  if (patch === null || stringField(args, "patchPath") !== null) return "any";
  const strip =
    typeof record.stripComponents === "number" && record.stripComponents >= 0
      ? Math.floor(record.stripComponents)
      : 1;
  const root = stringField(args, "rootDir");
  const found = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    const header = /^(?:---|\+\+\+) (.+)$/.exec(line);
    if (header === null) continue;
    const name = header[1]!.split("\t")[0]!.trim();
    if (name === "" || name === "/dev/null") continue;
    const parts = name.split(/[\\/]/);
    const rel = parts.slice(Math.min(strip, parts.length - 1)).join("/");
    const isAbsolute = rel.startsWith("/") || /^[a-zA-Z]:/.test(rel);
    found.add(
      normalizeLoopPath(root !== null && !isAbsolute ? `${root}/${rel}` : rel),
    );
  }
  return found.size === 0 ? "any" : [...found];
}

/**
 * Per-turn epoch book. Epochs are sequence numbers of the latest attempt
 * that opened one for a path, so they only ever grow for a given path --
 * eviction included: an evicted path's sequence becomes the floor every
 * later lookup starts from.
 */
export class MutationEpochs {
  private seq = 0;
  private anySeq = 0;
  private evictedFloor = 0;
  private anyFailures = 0;
  private readonly latest = new Map<string, number>();
  /** Consecutive failed attempts per path since a change last landed. */
  private readonly failures = new Map<string, number>();

  /**
   * Fold a completed (non-vetoed) call in; `landed` is whether it
   * succeeded. Returns the targets that opened a new epoch, so the caller
   * can reset its own per-path state, or `null` when none did.
   */
  note(
    tool: string,
    args: unknown,
    landed: boolean,
  ): readonly string[] | "any" | null {
    const targets = mutationTargets(tool, args);
    if (targets === null) return null;
    if (targets === "any") {
      this.anyFailures = landed ? 0 : this.anyFailures + 1;
      if (this.anyFailures > MAX_FAILED_EPOCHS) return null;
      this.seq += 1;
      this.anySeq = this.seq;
      return targets;
    }
    const opened: string[] = [];
    for (const path of targets) {
      const failed = landed ? 0 : (this.failures.get(path) ?? 0) + 1;
      this.failures.set(path, failed);
      if (failed > MAX_FAILED_EPOCHS) continue;
      opened.push(path);
    }
    if (opened.length === 0) return null;
    this.seq += 1;
    for (const path of opened) {
      this.latest.delete(path);
      this.latest.set(path, this.seq);
    }
    while (this.latest.size > MAX_TRACKED_PATHS) {
      const oldest = this.latest.entries().next();
      if (oldest.done) break;
      const [path, seq] = oldest.value;
      this.evictedFloor = Math.max(this.evictedFloor, seq);
      this.latest.delete(path);
      this.failures.delete(path);
    }
    while (this.failures.size > MAX_TRACKED_PATHS) {
      const oldest = this.failures.keys().next();
      if (oldest.done) break;
      this.failures.delete(oldest.value);
    }
    return opened;
  }

  /** The epoch a read of `path` (normalized) is made in now. */
  epochFor(path: string): number {
    let epoch = Math.max(this.anySeq, this.evictedFloor);
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
