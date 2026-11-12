import type { Dirent } from "node:fs";
import { opendir, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { isInside } from "../../../approval/fanout-scope.js";
import type { CandidateRoot } from "./path-candidate-roots.js";

export { candidateRoots, type CandidateRoot } from "./path-candidate-roots.js";

/**
 * Where a missing file or folder might really be.
 *
 * A local model asked to work with `backlinks_demo` read
 * `~/Desktop/Atomic Agent/backlinks_demo`, got ENOENT and sent the same
 * path three more times until the no-progress detector stopped it; the
 * folder was at `~/Desktop/backlinks_demo` (ATO-413). This search looks
 * for the last segment of the missing path, by exact name ignoring case
 * (NFC-normalised), in the places `candidateRoots` picks, so the error
 * can say where it actually is.
 *
 * Names only: it lists directories and compares entry names, it never
 * opens a file. It is bounded by wall clock and scanned entries, skips
 * hidden folders and known heavy trees, never descends into a folder the
 * roots marked as blocked (macOS privacy-protected folders the session
 * has not touched), does not follow symlinked folders, and never throws.
 *
 * Roots marked `outer` (folders above the session, such as the parent of
 * a working folder in the system temp folder, which can hold ~20,000
 * entries) are searched only after the others, under their own small
 * budget and a per-folder cap, so a crowded parent cannot use up the
 * search near the session (ATO-1333). Their matches are listed after the
 * near ones.
 */

export interface PathCandidate {
  path: string;
  kind: "file" | "folder" | "other";
}

/** What a search found, and whether it ran to the end. */
export interface CandidateSearch {
  found: PathCandidate[];
  /** False when the time or entry budget cut the search short. */
  complete: boolean;
}

export interface PathCandidateLimits {
  /** Wall-clock budget for the whole search. */
  timeBudgetMs: number;
  /** Directory entries examined under the near roots before giving up. */
  maxEntries: number;
  /** Directory entries examined under `outer` roots, after the near ones. */
  maxOuterEntries: number;
  /** Entries read from any one folder under an `outer` root. */
  maxEntriesPerOuterDir: number;
  /** Matches collected before stopping (one more than will be shown). */
  maxResults: number;
}

export const DEFAULT_CANDIDATE_LIMITS: PathCandidateLimits = {
  timeBudgetMs: 300,
  maxEntries: 20_000,
  maxOuterEntries: 2_000,
  maxEntriesPerOuterDir: 500,
  maxResults: 6,
};

export interface CandidateFilter {
  /** Folders never descended into, nor listed as a root. */
  blocked?: readonly string[];
  /** Whether a match may be reported; a rejected one is skipped. */
  accept?: (candidate: PathCandidate) => boolean;
}

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

/** The name to look for: the last segment of `missing`, or `null`. */
export function candidateName(missing: string): string | null {
  const name = basename(missing.replace(/[\\/]+$/, ""));
  if (name === "" || name === "." || name === "..") return null;
  return name;
}

/** The form two names are compared in. */
export function nameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * Entries named like the last segment of `missing`, at most
 * `limits.maxResults`: those under the near roots first, shallowest
 * first, then those under `outer` roots. `missing` itself is never
 * returned.
 */
export async function findPathCandidates(
  missing: string,
  roots: readonly CandidateRoot[],
  limits: PathCandidateLimits = DEFAULT_CANDIDATE_LIMITS,
  filter: CandidateFilter = {},
): Promise<CandidateSearch> {
  const name = candidateName(missing);
  if (name === null) return { found: [], complete: true };
  const found: PathCandidate[] = [];
  const state: WalkState = { stopped: false, cut: false, scanned: 0 };
  const deadline = Date.now() + limits.timeBudgetMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<void>((done) => {
    timer = setTimeout(() => {
      timedOut = true;
      done();
    }, limits.timeBudgetMs);
    timer.unref?.();
  });
  const walk = new Walk(nameKey(name), resolve(missing), limits, deadline, state, found, filter);
  const near = roots.filter((root) => root.outer !== true);
  const outer = roots.filter((root) => root.outer === true);
  const search = (async () => {
    await walk.run(near, { maxEntries: limits.maxEntries });
    await walk.run(outer, {
      maxEntries: limits.maxOuterEntries,
      perDir: limits.maxEntriesPerOuterDir,
    });
  })().catch(() => {
    // Best effort: whatever was found before the failure stands.
  });
  try {
    await Promise.race([search, timeout]);
  } finally {
    state.stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  }
  return {
    found: found.slice(0, limits.maxResults),
    complete: !state.cut && !(timedOut && found.length < limits.maxResults),
  };
}

interface WalkState {
  stopped: boolean;
  /** The time or entry budget ran out before the walk ended. */
  cut: boolean;
  /** Entries examined in the current pass. */
  scanned: number;
}

/** One pass's entry budget; `perDir` caps the entries read from each folder. */
interface PassBudget {
  maxEntries: number;
  perDir?: number;
}

/**
 * Breadth-first over every root of a pass at once, level by level, so a
 * match one level below the nearest folder is found before a deep one
 * elsewhere. A folder reached from two roots, or in both passes, is
 * listed once.
 */
class Walk {
  private readonly visited = new Set<string>();
  private readonly seen: Set<string>;
  private readonly blocked: string[];

  constructor(
    private readonly wanted: string,
    missing: string,
    private readonly limits: PathCandidateLimits,
    private readonly deadline: number,
    private readonly state: WalkState,
    private readonly found: PathCandidate[],
    private readonly filter: CandidateFilter,
  ) {
    this.seen = new Set([missing]);
    this.blocked = (filter.blocked ?? []).map((dir) => resolve(dir));
  }

  async run(roots: readonly CandidateRoot[], budget: PassBudget): Promise<void> {
    this.state.scanned = 0;
    let level = roots
      .map((root) => ({ dir: resolve(root.dir), left: root.depth }))
      .filter(({ dir }) => !this.isBlocked(dir));
    while (level.length > 0) {
      const next: typeof level = [];
      for (const { dir, left } of level) {
        if (left <= 0 || this.visited.has(dir)) continue;
        this.visited.add(dir);
        if (this.shouldStop(budget)) return;
        const { entries, more } = await listDir(dir, budget.perDir);
        if (this.state.stopped) return;
        if (more) this.state.cut = true;
        for (const entry of entries) {
          this.state.scanned++;
          const path = join(dir, entry.name);
          if (this.matches(entry, path) && this.full()) return;
          if (entry.isDirectory() && !skipped(entry.name) && !this.isBlocked(path)) {
            next.push({ dir: path, left: left - 1 });
          }
        }
      }
      level = next;
    }
  }

  /** Record `entry` when it matches; true when it was recorded. */
  private matches(entry: Dirent, path: string): boolean {
    if (nameKey(entry.name) !== this.wanted || this.seen.has(path)) return false;
    this.seen.add(path);
    const candidate: PathCandidate = { path, kind: kindOf(entry) };
    if (this.filter.accept !== undefined && !this.filter.accept(candidate)) {
      return false;
    }
    this.found.push(candidate);
    return true;
  }

  private full(): boolean {
    return this.found.length >= this.limits.maxResults;
  }

  private shouldStop(budget: PassBudget): boolean {
    if (this.state.stopped || this.full()) return true;
    if (this.state.scanned >= budget.maxEntries || Date.now() >= this.deadline) {
      this.state.cut = true;
      return true;
    }
    return false;
  }

  private isBlocked(dir: string): boolean {
    return this.blocked.some((blocked) => isInside(blocked, dir));
  }
}

/**
 * The entries of `dir`, or none when it cannot be listed. With `max`, at
 * most that many are read and `more` says whether the folder held more.
 */
async function listDir(
  dir: string,
  max?: number,
): Promise<{ entries: Dirent[]; more: boolean }> {
  try {
    if (max === undefined) {
      return { entries: (await readdir(dir, { withFileTypes: true })) as Dirent[], more: false };
    }
    const entries: Dirent[] = [];
    // Breaking out of the loop closes the handle.
    for await (const entry of await opendir(dir)) {
      if (entries.length >= max) return { entries, more: true };
      entries.push(entry);
    }
    return { entries, more: false };
  } catch {
    return { entries: [], more: false };
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
