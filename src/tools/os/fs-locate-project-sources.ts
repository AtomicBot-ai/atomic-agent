import { readdir, stat } from "node:fs/promises";
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

export function matchTier(
  candidateBasename: string,
  query: string,
): MatchTier | null {
  const base = candidateBasename.toLowerCase();
  if (base === query) return 0;
  if (base.startsWith(query)) return 1;
  if (base.includes(query)) return 2;
  return null;
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
 */
export async function collectConfiguredRoots(
  roots: readonly string[],
  query: string,
): Promise<RootScanResult> {
  const result: RootScanResult = {
    candidates: [],
    rootsScanned: 0,
    invalidRoots: [],
    unreadableRoots: [],
    truncatedRoots: [],
  };
  for (const raw of roots) {
    if (typeof raw !== "string" || raw.trim().length === 0) continue;
    const expanded = expandHome(raw.trim());
    if (!isAbsolute(expanded)) {
      result.invalidRoots.push(raw);
      continue;
    }
    const root = resolve(expanded);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      result.unreadableRoots.push(root);
      continue;
    }
    result.rootsScanned += 1;

    const rootTier = matchTier(basename(root), query);
    if (rootTier !== null) {
      result.candidates.push({
        path: root,
        source: "configured-root",
        tier: rootTier,
        recency: 0,
      });
    }
    if (entries.length > MAX_ROOT_ENTRIES) result.truncatedRoots.push(root);
    for (const entry of entries.slice(0, MAX_ROOT_ENTRIES)) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
      const tier = matchTier(entry.name, query);
      if (tier === null) continue;
      result.candidates.push({
        path: join(root, entry.name),
        source: "configured-root",
        tier,
        recency: 0,
      });
    }
  }
  return result;
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

export function sortCandidates(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) =>
      a.tier - b.tier ||
      SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source] ||
      b.recency - a.recency ||
      a.path.localeCompare(b.path),
  );
}
