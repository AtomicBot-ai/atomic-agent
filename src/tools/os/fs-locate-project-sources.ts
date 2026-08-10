import { opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { expandHome } from "./expand-home.js";

/**
 * Candidate collection for `os.fs.locate_project` (issue #77). Every
 * source is bounded and allow-listed — no disk-wide or $HOME crawling:
 *
 *   `cwd`             — session working dir + ancestors (path depth).
 *   `session-history` — recent sessions' working dirs (already persisted
 *                       by the runtime; existence-checked before use).
 *   `configured-root` — user-declared `projects.roots` and their direct
 *                       children (ONE level, dirs only; hidden dirs,
 *                       dependency caches, and symlinks skipped).
 */

export interface RecentSessionDir {
  workingDir: string;
  updatedAt: number;
}

export type CandidateSource = "cwd" | "session-history" | "configured-root";

/** Lower is better: exact basename, then prefix, then substring. */
export type MatchTier = 0 | 1 | 2;

export interface Candidate {
  path: string;
  source: CandidateSource;
  tier: MatchTier;
  /** Higher wins inside a tier (session recency; cwd outranks all). */
  recency: number;
}

/** How many recent sessions contribute their working dirs. */
export const RECENT_SESSIONS_SCAN_LIMIT = 100;
/** Per-root cap on scanned children so a huge root stays bounded. */
export const MAX_ROOT_ENTRIES = 500;
/** Dependency/cache dirs that are never project matches. */
const SKIPPED_DIR_NAMES = new Set(["node_modules", "__pycache__"]);

const SOURCE_PRIORITY: Record<CandidateSource, number> = {
  cwd: 0,
  "session-history": 1,
  "configured-root": 2,
};

/**
 * Both sides are NFC-normalized before the casefold compare: macOS
 * stores names in NFD, users type NFC — without this "Café" typed in
 * chat never matches "Café" on disk. The query passed in must already
 * be `normalizeForMatch`ed by the caller.
 */
export function matchTier(
  candidateBasename: string,
  query: string,
): MatchTier | null {
  const base = normalizeForMatch(candidateBasename);
  if (base === query) return 0;
  if (base.startsWith(query)) return 1;
  if (base.includes(query)) return 2;
  return null;
}

export function normalizeForMatch(input: string): string {
  return input.normalize("NFC").toLowerCase();
}

/** The working dir itself plus every ancestor, bounded by path depth. */
export function collectCwdChain(workingDir: string, query: string): Candidate[] {
  const out: Candidate[] = [];
  let dir = resolve(workingDir);
  for (;;) {
    const tier = matchTier(basename(dir), query);
    if (tier !== null) {
      out.push({ path: dir, source: "cwd", tier, recency: Number.MAX_SAFE_INTEGER });
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

export function collectSessionHistory(
  sessions: readonly RecentSessionDir[],
  query: string,
): Candidate[] {
  const newestByDir = new Map<string, number>();
  for (const s of sessions) {
    if (typeof s.workingDir !== "string" || s.workingDir.length === 0) continue;
    const dir = resolve(s.workingDir);
    const seen = newestByDir.get(dir);
    if (seen === undefined || s.updatedAt > seen) newestByDir.set(dir, s.updatedAt);
  }
  const out: Candidate[] = [];
  for (const [dir, updatedAt] of newestByDir) {
    const tier = matchTier(basename(dir), query);
    if (tier === null) continue;
    out.push({ path: dir, source: "session-history", tier, recency: updatedAt });
  }
  return out;
}

export interface RootScanResult {
  candidates: Candidate[];
  rootsScanned: number;
  /** Roots skipped because they are not absolute after `~` expansion. */
  invalidRoots: string[];
  /** Roots that exist in config but could not be read. */
  unreadableRoots: string[];
  truncatedRoots: string[];
}

/**
 * One-level scan: each configured root's own basename plus its direct
 * child directories. Recursion never happens.
 *
 * The listing is streamed via `opendir` (small internal batches), so a
 * root that trips the 500-eligible-dirs cap stops reading right there
 * instead of materialising the whole directory the way `readdir`
 * would. Only eligible dirs count toward the cap: loose files, hidden
 * names, and dependency caches cannot evict project dirs from the
 * window. `signal` aborts between roots and between entries.
 */
export async function collectConfiguredRoots(
  roots: readonly string[],
  query: string,
  signal?: AbortSignal,
): Promise<RootScanResult> {
  const result: RootScanResult = {
    candidates: [],
    rootsScanned: 0,
    invalidRoots: [],
    unreadableRoots: [],
    truncatedRoots: [],
  };
  for (const raw of roots) {
    signal?.throwIfAborted();
    if (typeof raw !== "string") continue;
    if (raw.trim().length === 0) {
      // A whitespace-only entry survives config validation (it is a
      // non-empty string) — report it instead of skipping silently.
      result.invalidRoots.push(raw);
      continue;
    }
    const expanded = expandHome(raw.trim());
    if (!isAbsolute(expanded)) {
      result.invalidRoots.push(raw);
      continue;
    }
    const root = resolve(expanded);
    let dir;
    try {
      dir = await opendir(root);
    } catch {
      result.unreadableRoots.push(root);
      continue;
    }

    const rootCandidates: Candidate[] = [];
    const rootTier = matchTier(basename(root), query);
    if (rootTier !== null) {
      rootCandidates.push({
        path: root,
        source: "configured-root",
        tier: rootTier,
        recency: 0,
      });
    }

    let truncated = false;
    let eligibleSeen = 0;
    try {
      for await (const entry of dir) {
        signal?.throwIfAborted();
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
        eligibleSeen += 1;
        if (eligibleSeen > MAX_ROOT_ENTRIES) {
          // Cap hit: stop pulling entries entirely (break closes the
          // dir handle via the async iterator's return()).
          truncated = true;
          break;
        }
        const tier = matchTier(entry.name, query);
        if (tier === null) continue;
        rootCandidates.push({
          path: join(root, entry.name),
          source: "configured-root",
          tier,
          recency: 0,
        });
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      // Mid-stream read failure: count the root as unreadable and drop
      // its partial candidates so the outcome stays deterministic.
      result.unreadableRoots.push(root);
      continue;
    }

    result.rootsScanned += 1;
    if (truncated) result.truncatedRoots.push(root);
    result.candidates.push(...rootCandidates);
  }
  return result;
}

/**
 * Canonicalize candidate paths through `realpath` so the same directory
 * reached via different spellings (macOS `/tmp` vs `/private/tmp`, a
 * symlinked session cwd vs a configured-root child) collapses in
 * `dedupeByPath` instead of producing a false ambiguous verdict. A
 * failed `realpath` (deleted dir) keeps the original path — the later
 * existence check drops it.
 */
export async function canonicalizePaths(
  candidates: readonly Candidate[],
): Promise<Candidate[]> {
  return Promise.all(
    candidates.map(async (c) => {
      try {
        return { ...c, path: await realpath(c.path) };
      } catch {
        return c;
      }
    }),
  );
}

/** First writer wins; input order already encodes source priority. */
export function dedupeByPath(candidates: readonly Candidate[]): Candidate[] {
  const byPath = new Map<string, Candidate>();
  for (const c of candidates) {
    if (!byPath.has(c.path)) byPath.set(c.path, c);
  }
  return [...byPath.values()];
}

/**
 * Root-scan candidates were just readdir'd; cwd/session dirs may have
 * been deleted since they were recorded, so stat only those.
 */
export async function dropMissingDirs(
  candidates: readonly Candidate[],
): Promise<Candidate[]> {
  const checks = await Promise.all(
    candidates.map(async (c) => {
      if (c.source === "configured-root") return c;
      try {
        return (await stat(c.path)).isDirectory() ? c : null;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((c): c is Candidate => c !== null);
}

/**
 * Absolute-path fast path. `~` is expanded first so "~/dev/raylib"
 * counts; a non-directory or missing path falls through to the normal
 * search (its last segment may still match a source). The returned
 * path is realpath'd when possible.
 */
export async function resolveDirectPath(rawName: string): Promise<string | null> {
  const expanded = expandHome(rawName);
  if (!isAbsolute(expanded)) return null;
  try {
    if (!(await stat(expanded)).isDirectory()) return null;
  } catch {
    return null;
  }
  try {
    return await realpath(expanded);
  } catch {
    return resolve(expanded);
  }
}

export function sortCandidates(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) =>
      a.tier - b.tier ||
      SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source] ||
      b.recency - a.recency ||
      a.path.localeCompare(b.path),
  );
}
