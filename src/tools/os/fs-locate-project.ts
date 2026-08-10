import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import { expandHome } from "./expand-home.js";
import {
  canonicalizePaths,
  collectConfiguredRoots,
  collectCwdChain,
  collectSessionHistory,
  dedupeByPath,
  dropMissingDirs,
  normalizeForMatch,
  sortCandidates,
  MAX_ROOT_ENTRIES,
  RECENT_SESSIONS_SCAN_LIMIT,
  type Candidate,
  type RecentSessionDir,
  type RootScanResult,
} from "./fs-locate-project-sources.js";

/**
 * `os.fs.locate_project` — resolve a fuzzy project name ("my raylib
 * project") to a directory path without the user spelling out the full
 * path (issue #77).
 *
 * The search space is deliberately bounded (see
 * `fs-locate-project-sources.ts`): session cwd + ancestors, recent
 * session dirs, and one-level children of the user-declared
 * `projects.roots`. There is no recursion, no $HOME walk, and no
 * background index. A miss is an honest miss: the output tells the
 * model to ask the user for the full path or to add a root to
 * `projects.roots`. Two or more equally good matches are reported as
 * ambiguous — the model is instructed to ask, never to guess.
 */

export interface OsFsLocateProjectDeps {
  /** Most-recently-updated sessions first (`SessionStore.listRecent`). */
  listRecentSessions: (limit: number) => readonly RecentSessionDir[];
  /** User-declared project roots (`projects.roots`, config v36). */
  projectRoots: readonly string[];
}

const DEFAULT_CANDIDATE_LIMIT = 8;
const MAX_CANDIDATE_LIMIT = 25;

export function buildOsFsLocateProjectTool(
  deps: OsFsLocateProjectDeps,
): ToolDefinition {
  return {
    name: "os.fs.locate_project",
    description:
      "Resolve a project name mentioned by the user (e.g. 'my raylib project') " +
      "to a directory path. Searches only the session working dir and its " +
      "ancestors, recent session dirs, and the user-configured projects.roots " +
      "(one level deep). Never scans the whole disk. On multiple matches, ask " +
      "the user to pick one; on no match, ask for the full path.",
    readonly: true,
    async run(rawArgs, ctx) {
      const { query, rawName, limit } = parseArgs(rawArgs);

      // Fast path: the user pasted an absolute path (issue screenshot:
      // "can you check on e:/_raylib"). If it exists as a directory,
      // return it — never answer "give me the full path" to a full path.
      const direct = await resolveDirectPath(rawName);
      if (direct !== null) {
        return compressToolResult(
          {
            tool: "os.fs.locate_project",
            status: "ok",
            output: `project "${rawName}" -> ${direct} (source: direct-path)`,
            details: {
              query: rawName,
              found: true,
              ambiguous: false,
              path: direct,
              source: "direct-path",
              candidates: [{ path: direct, source: "direct-path" }],
              rootsScanned: 0,
            },
          },
          { maxSummaryLength: 2000, maxTailLines: 40 },
        );
      }

      const collected: Candidate[] = [
        ...collectCwdChain(ctx.workingDir, query),
        ...collectSessionHistory(
          deps.listRecentSessions(RECENT_SESSIONS_SCAN_LIMIT),
          query,
        ),
      ];
      const rootScan = await collectConfiguredRoots(deps.projectRoots, query);
      collected.push(...rootScan.candidates);

      // realpath before dedupe: the same dir reached via different
      // spellings (/tmp vs /private/tmp, symlinked session cwd) must
      // collapse instead of reading as a false ambiguity.
      const canonical = await canonicalizePaths(collected);
      const deduped = dedupeByPath(canonical);
      const alive = await dropMissingDirs(deduped);
      // The verdict (found / ambiguous) is computed over the FULL match
      // list; `limit` only caps how many candidates are listed. A tight
      // limit must never turn a tie into a confident single answer.
      const sorted = sortCandidates(alive);
      const displayed = sorted.slice(0, limit);

      const output = renderOutput(
        rawName,
        sorted,
        displayed,
        deps.projectRoots.length,
        rootScan,
      );
      return compressToolResult(
        {
          tool: "os.fs.locate_project",
          status: "ok",
          output,
          details: buildDetails(rawName, sorted, displayed, rootScan),
        },
        // Room for the header plus a full candidate list; the tail
        // trimmer keeps LAST lines, so a short cap would eat the verdict.
        { maxSummaryLength: 2000, maxTailLines: 40 },
      );
    },
  };
}

function parseArgs(raw: Record<string, unknown>): {
  query: string;
  rawName: string;
  limit: number;
} {
  const name = raw.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("os.fs.locate_project: `name` must be a non-empty string");
  }
  const rawName = name.trim();
  // Tolerate a pasted path fragment ("e:/_raylib", "e:\\_raylib") by
  // matching on its last segment. Backslashes are normalized first so
  // Windows-style input parses on every host platform; falls back to
  // the trimmed input when basename is empty.
  const lastSegment = basename(rawName.replace(/\\/g, "/"));
  const query = normalizeForMatch(lastSegment.length > 0 ? lastSegment : rawName);

  const limit =
    typeof raw.limit === "number" && Number.isFinite(raw.limit)
      ? Math.min(MAX_CANDIDATE_LIMIT, Math.max(1, Math.floor(raw.limit)))
      : DEFAULT_CANDIDATE_LIMIT;
  return { query, rawName, limit };
}

/**
 * Absolute-path fast path. `~` is expanded first so "~/dev/raylib"
 * counts; a non-directory or missing path falls through to the normal
 * search (its last segment may still match a source). The returned
 * path is realpath'd when possible.
 */
async function resolveDirectPath(rawName: string): Promise<string | null> {
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

function splitBestTier(matches: readonly Candidate[]): {
  best: readonly Candidate[];
  rest: readonly Candidate[];
} {
  const first = matches[0];
  if (first === undefined) return { best: [], rest: [] };
  const bestTier = first.tier;
  return {
    best: matches.filter((m) => m.tier === bestTier),
    rest: matches.filter((m) => m.tier !== bestTier),
  };
}

/**
 * Root-scan problems must land in the OUTPUT text: the model only ever
 * sees the compressed summary (`toolResultTurn` carries no details), so
 * anything details-only is invisible to it.
 */
function renderRootNotes(rootScan: RootScanResult): string[] {
  const notes: string[] = [];
  if (rootScan.invalidRoots.length > 0) {
    notes.push(
      `note: ${rootScan.invalidRoots.length} configured root(s) skipped ` +
        `(empty or not absolute): ${rootScan.invalidRoots
          .map((r) => JSON.stringify(r))
          .join(", ")}`,
    );
  }
  if (rootScan.unreadableRoots.length > 0) {
    notes.push(
      `note: ${rootScan.unreadableRoots.length} configured root(s) could not ` +
        `be read: ${rootScan.unreadableRoots.join(", ")}`,
    );
  }
  for (const root of rootScan.truncatedRoots) {
    notes.push(
      `note: root ${root} truncated at ${MAX_ROOT_ENTRIES} entries; ` +
        `matches beyond the cap were not scanned`,
    );
  }
  return notes;
}

function renderOutput(
  rawName: string,
  sorted: readonly Candidate[],
  displayed: readonly Candidate[],
  configuredRootCount: number,
  rootScan: RootScanResult,
): string {
  const notes = renderRootNotes(rootScan);
  const { best } = splitBestTier(sorted);
  const hit = best.length === 1 ? best[0] : undefined;
  if (hit !== undefined) {
    const lines = [`project "${rawName}" -> ${hit.path} (source: ${hit.source})`];
    const weaker = displayed.filter((c) => c.path !== hit.path);
    if (weaker.length > 0) {
      lines.push(`weaker matches (mention only if the resolved path looks wrong):`);
      for (const alt of weaker) lines.push(`  - ${alt.path} (${alt.source})`);
    }
    return [...lines, ...notes].join("\n");
  }
  if (best.length > 1) {
    const lines = [
      `ambiguous: ${best.length} directories match "${rawName}" equally well. ` +
        `Ask the user which one they mean; do not guess.`,
    ];
    for (const c of displayed) lines.push(`  - ${c.path} (${c.source})`);
    if (sorted.length > displayed.length) {
      lines.push(`  (and ${sorted.length - displayed.length} more; raise limit to list them)`);
    }
    return [...lines, ...notes].join("\n");
  }
  // Honest miss: report how many roots were actually scanned, never the
  // configured count (all of them may have been unreadable).
  let hint: string;
  if (configuredRootCount === 0) {
    hint =
      `No projects.roots are configured; the user can add parent directories ` +
      `of their projects to "projects.roots" in the agent config to widen the search.`;
  } else if (rootScan.rootsScanned === 0) {
    hint =
      `Checked the session working dir and recent session dirs; none of the ` +
      `${configuredRootCount} configured projects.roots could be scanned (see notes).`;
  } else {
    hint =
      `Checked the session working dir, recent session dirs, and ` +
      `${rootScan.rootsScanned} configured root(s).`;
  }
  return [
    `no project directory matching "${rawName}" was found. ` +
      `Ask the user for the full path. ${hint}`,
    ...notes,
  ].join("\n");
}

function buildDetails(
  rawName: string,
  sorted: readonly Candidate[],
  displayed: readonly Candidate[],
  rootScan: RootScanResult,
): Record<string, unknown> {
  const { best } = splitBestTier(sorted);
  const top = best.length === 1 ? best[0] : undefined;
  return {
    query: rawName,
    found: top !== undefined,
    ambiguous: best.length > 1,
    ...(top !== undefined ? { path: top.path, source: top.source } : {}),
    candidates: displayed.map((m) => ({ path: m.path, source: m.source })),
    rootsScanned: rootScan.rootsScanned,
    ...(rootScan.invalidRoots.length > 0
      ? { invalidRoots: rootScan.invalidRoots }
      : {}),
    ...(rootScan.unreadableRoots.length > 0
      ? { unreadableRoots: rootScan.unreadableRoots }
      : {}),
    ...(rootScan.truncatedRoots.length > 0
      ? { truncatedRoots: rootScan.truncatedRoots }
      : {}),
  };
}
