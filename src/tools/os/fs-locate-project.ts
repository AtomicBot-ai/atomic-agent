import { basename } from "node:path";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import {
  collectConfiguredRoots,
  collectCwdChain,
  collectSessionHistory,
  dedupeByPath,
  dropMissingDirs,
  sortCandidates,
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

      const collected: Candidate[] = [
        ...collectCwdChain(ctx.workingDir, query),
        ...collectSessionHistory(
          deps.listRecentSessions(RECENT_SESSIONS_SCAN_LIMIT),
          query,
        ),
      ];
      const rootScan = await collectConfiguredRoots(deps.projectRoots, query);
      collected.push(...rootScan.candidates);

      const deduped = dedupeByPath(collected);
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
  // Tolerate a pasted path fragment ("e:/_raylib") — match on its last
  // segment. Falls back to the trimmed input when basename is empty.
  const lastSegment = basename(rawName);
  const query = (lastSegment.length > 0 ? lastSegment : rawName).toLowerCase();

  const limit =
    typeof raw.limit === "number" && Number.isFinite(raw.limit)
      ? Math.min(MAX_CANDIDATE_LIMIT, Math.max(1, Math.floor(raw.limit)))
      : DEFAULT_CANDIDATE_LIMIT;
  return { query, rawName, limit };
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

function renderOutput(
  rawName: string,
  sorted: readonly Candidate[],
  displayed: readonly Candidate[],
  configuredRootCount: number,
): string {
  const { best } = splitBestTier(sorted);
  const hit = best.length === 1 ? best[0] : undefined;
  if (hit !== undefined) {
    const lines = [`project "${rawName}" -> ${hit.path} (source: ${hit.source})`];
    const weaker = displayed.filter((c) => c.path !== hit.path);
    if (weaker.length > 0) {
      lines.push(`weaker matches (mention only if the resolved path looks wrong):`);
      for (const alt of weaker) lines.push(`  - ${alt.path} (${alt.source})`);
    }
    return lines.join("\n");
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
    return lines.join("\n");
  }
  const hint =
    configuredRootCount === 0
      ? `No projects.roots are configured — the user can add parent directories of their projects to "projects.roots" in the agent config to widen the search.`
      : `Checked the session working dir, recent session dirs, and ${configuredRootCount} configured root(s).`;
  return (
    `no project directory matching "${rawName}" was found. ` +
    `Ask the user for the full path. ${hint}`
  );
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
