import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/**
 * Where a missing file or folder might really be.
 *
 * A local model asked to work with `backlinks_demo` read
 * `~/Desktop/Atomic Agent/backlinks_demo`, got ENOENT and sent the same
 * path three more times until the no-progress detector stopped it; the
 * folder was at `~/Desktop/backlinks_demo` (ATO-413). A bare ENOENT gives
 * the model nothing to do next. This search looks for the last segment
 * of the missing path, by exact name ignoring case, in a few likely
 * places, so the error can say where it actually is.
 *
 * Names only: it lists directories and compares entry names, it never
 * opens a file. It is bounded by wall clock and scanned entries, skips
 * hidden folders and known heavy trees, does not follow symlinked
 * folders, and never throws: on any trouble it returns what it found.
 */

/** One directory to search and how many levels below it to look. */
export interface CandidateRoot {
  dir: string;
  /** 1 = the root's direct children only. */
  depth: number;
}

export interface PathCandidate {
  path: string;
  kind: "file" | "folder" | "other";
}

export interface PathCandidateLimits {
  /** Wall-clock budget for the whole search. */
  timeBudgetMs: number;
  /** Directory entries examined before giving up. */
  maxEntries: number;
  /** Matches collected before stopping (one more than will be shown). */
  maxResults: number;
}

export const DEFAULT_CANDIDATE_LIMITS: PathCandidateLimits = {
  timeBudgetMs: 300,
  maxEntries: 20_000,
  maxResults: 6,
};

/** Folder names never descended into: big, generated, or system-owned. */
const SKIPPED_DIRS = new Set(
  [
    "node_modules",
    "Library",
    "AppData",
    "Applications",
    "System",
    "dist",
    "build",
    "target",
    "vendor",
    "venv",
    "__pycache__",
    "site-packages",
    "$Recycle.Bin",
  ].map((name) => name.toLowerCase()),
);

/**
 * The places a user usually means: the working folder, then Desktop,
 * Documents and Downloads, then the home folder itself (shallower, as it
 * holds the others and much more).
 */
export function defaultCandidateRoots(
  workingDir: string,
  home: string,
): CandidateRoot[] {
  return [
    { dir: workingDir, depth: 3 },
    { dir: join(home, "Desktop"), depth: 3 },
    { dir: join(home, "Documents"), depth: 3 },
    { dir: join(home, "Downloads"), depth: 3 },
    { dir: home, depth: 2 },
  ];
}

/** The name to look for: the last segment of `missing`, or `null`. */
export function candidateName(missing: string): string | null {
  const name = basename(missing.replace(/[\\/]+$/, ""));
  if (name === "" || name === "." || name === "..") return null;
  return name;
}

/**
 * Entries named like the last segment of `missing` (case-insensitive),
 * shallowest first, at most `limits.maxResults`. `missing` itself is
 * never returned.
 */
export async function findPathCandidates(
  missing: string,
  roots: readonly CandidateRoot[],
  limits: PathCandidateLimits = DEFAULT_CANDIDATE_LIMITS,
): Promise<PathCandidate[]> {
  const name = candidateName(missing);
  if (name === null) return [];
  const found: PathCandidate[] = [];
  const state = { stopped: false, scanned: 0 };
  const deadline = Date.now() + limits.timeBudgetMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((done) => {
    timer = setTimeout(done, limits.timeBudgetMs);
    timer.unref?.();
  });
  const search = (async () => {
    try {
      await walkRoots(name, resolve(missing), roots, limits, deadline, state, found);
    } catch {
      // Best effort: whatever was found before the failure stands.
    }
  })();
  try {
    await Promise.race([search, timeout]);
  } finally {
    state.stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  }
  return found.slice(0, limits.maxResults);
}

interface WalkState {
  stopped: boolean;
  scanned: number;
}

/**
 * Breadth-first over every root at once, level by level, so a match one
 * level below Desktop is found before a deep one under the working
 * folder. A folder reached from two roots is listed once.
 */
async function walkRoots(
  name: string,
  missing: string,
  roots: readonly CandidateRoot[],
  limits: PathCandidateLimits,
  deadline: number,
  state: WalkState,
  found: PathCandidate[],
): Promise<void> {
  const wanted = name.toLowerCase();
  const visited = new Set<string>();
  const seen = new Set<string>([missing]);
  let level = roots.map((root) => ({
    dir: resolve(root.dir),
    left: root.depth,
  }));
  while (level.length > 0) {
    const next: typeof level = [];
    for (const { dir, left } of level) {
      if (left <= 0 || visited.has(dir)) continue;
      visited.add(dir);
      if (shouldStop(state, limits, deadline, found)) return;
      const entries = await listDir(dir);
      if (state.stopped) return;
      for (const entry of entries) {
        state.scanned++;
        const path = join(dir, entry.name);
        if (entry.name.toLowerCase() === wanted && !seen.has(path)) {
          seen.add(path);
          found.push({ path, kind: kindOf(entry) });
          if (found.length >= limits.maxResults) return;
        }
        if (entry.isDirectory() && !skipped(entry.name)) {
          next.push({ dir: path, left: left - 1 });
        }
      }
    }
    level = next;
  }
}

function shouldStop(
  state: WalkState,
  limits: PathCandidateLimits,
  deadline: number,
  found: readonly PathCandidate[],
): boolean {
  return (
    state.stopped ||
    state.scanned >= limits.maxEntries ||
    found.length >= limits.maxResults ||
    Date.now() >= deadline
  );
}

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return [];
  }
}

function skipped(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIRS.has(name.toLowerCase());
}

function kindOf(entry: Dirent): PathCandidate["kind"] {
  if (entry.isDirectory()) return "folder";
  if (entry.isFile()) return "file";
  return "other";
}
