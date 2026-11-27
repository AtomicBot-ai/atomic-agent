import { isAbsolute, join, relative } from "node:path";

/**
 * The files Fusion workers changed, with lines added and removed, for a
 * host's "Changed files" card (ATO-1700).
 *
 * A worker's own `os.fs.write` / `os.fs.edit` results carry
 * `details.diffstat` like the chat's do (ATO-1187), but they run in the
 * worker's session and never reach the chat's stream. Each worker keeps
 * its list on its result row (`WorkerTaskResult.diffstats`), and
 * `fusion.delegate` sums the rows into `details.diffstats`, which the
 * chat's `tool_result` frame carries (ATO-1701).
 */
export interface FileDiffStat {
  /** Absolute, as the write tool reported it (or rebased to the folder). */
  path: string;
  added: number;
  removed: number;
}

/** Tools whose ok result carries `details.diffstat` (ATO-1187). */
const DIFFSTAT_TOOLS: ReadonlySet<string> = new Set(["os.fs.write", "os.fs.edit"]);

const count = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0;

/** The file an ok write/edit changed and its counts, or null. */
export function diffStatOfResult(result: {
  tool: string;
  status: string;
  details?: Record<string, unknown>;
}): FileDiffStat | null {
  if (!DIFFSTAT_TOOLS.has(result.tool) || result.status !== "ok") return null;
  const details = result.details ?? {};
  const path = details.path;
  const raw = details.diffstat;
  if (typeof path !== "string" || path.length === 0) return null;
  if (typeof raw !== "object" || raw === null) return null;
  const { added, removed } = raw as { added?: unknown; removed?: unknown };
  if (!count(added) || !count(removed)) return null;
  return { path, added, removed };
}

/** The list with one more change: a path already on it adds its counts, a new one goes last. */
export function addDiffStat(
  list: readonly FileDiffStat[],
  entry: FileDiffStat,
): FileDiffStat[] {
  const out = list.slice();
  const i = out.findIndex((f) => f.path === entry.path);
  if (i >= 0) {
    const f = out[i]!;
    out[i] = {
      path: f.path,
      added: f.added + entry.added,
      removed: f.removed + entry.removed,
    };
  } else {
    out.push({ path: entry.path, added: entry.added, removed: entry.removed });
  }
  return out;
}

/**
 * A file list read back from a run checkpoint (ATO-1756): entries that
 * are not a path with two counts are dropped; anything but an array,
 * as in a checkpoint written before the field existed, is no files.
 */
export function readDiffStats(raw: unknown): FileDiffStat[] {
  if (!Array.isArray(raw)) return [];
  let out: FileDiffStat[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { path, added, removed } = item as Record<string, unknown>;
    if (typeof path !== "string" || path.length === 0) continue;
    if (!count(added) || !count(removed)) continue;
    out = addDiffStat(out, { path, added, removed });
  }
  return out;
}

/** Every worker's files on one list: one row per path, counts summed. */
export function sumDiffStats(
  rows: readonly { diffstats?: readonly FileDiffStat[] }[],
): FileDiffStat[] {
  let out: FileDiffStat[] = [];
  for (const row of rows) {
    for (const entry of row.diffstats ?? []) out = addDiffStat(out, entry);
  }
  return out;
}

/**
 * A workspace worker's files as the folder has them after the merge:
 * a path inside the workspace becomes the same path inside `realDir`,
 * kept only when the merge wrote it (`applied`, relative to the folder).
 * A file left out of the merge (a conflict, a refused input) did not
 * change in the folder, so it is not shown.
 */
export function rebaseDiffStats(
  stats: readonly FileDiffStat[],
  workspaceDir: string,
  realDir: string,
  applied: readonly string[],
): FileDiffStat[] {
  const merged = new Set(applied);
  const out: FileDiffStat[] = [];
  for (const entry of stats) {
    const rel = relative(workspaceDir, entry.path);
    if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) continue;
    if (!merged.has(rel)) continue;
    out.push({ ...entry, path: join(realDir, rel) });
  }
  return out;
}
