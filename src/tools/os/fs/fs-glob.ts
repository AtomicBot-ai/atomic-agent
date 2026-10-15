import { OS_FS_GLOB_CONTRACT } from "./fs-glob-contract.js";
import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  compressToolResult,
  retainToolOutput,
} from "../../../compressor/result-compressor.js";
import { resolveUserPath } from "../expand-home.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { compileGlob, matchesAny } from "./fs-glob-pattern.js";
import {
  createWalkBudget,
  DEFAULT_WALK_BUDGET,
  describeWalkStop,
  type WalkBudgetLimits,
  type WalkStop,
} from "./fs-walk-budget.js";

export { compileGlob } from "./fs-glob-pattern.js";

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/target/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/Library/**",
  "**/.rustup/**",
  "**/.cargo/**",
  "**/.npm/**",
  "**/.pnpm-store/**",
  "**/.yarn/**",
  "**/.gradle/**",
  "**/.m2/**",
  "**/__pycache__/**",
  "**/site-packages/**",
  "**/vendor/**",
  "**/.venv/**",
  "**/venv/**",
  "**/.tox/**",
  "**/.pytest_cache/**",
  "**/.mypy_cache/**",
  "**/.ruff_cache/**",
  "**/.terraform/**",
  "**/.idea/**",
  "**/.vscode/**",
  "**/.Trash/**",
  "**/.svn/**",
  "**/.hg/**",
];
const DEFAULT_LIMIT = 1000;
// Hard scan ceiling: walk visits up to this many matching files before forcibly
// truncating. Decoupled from `limit` so that `sortByMtime` and alphabetical
// sort actually consider the whole tree (within reason) before slicing.
const MAX_FILES_COLLECTED = 50_000;

interface GlobArgs {
  patterns: string[];
  cwd: string;
  ignore: string[];
  absolute: boolean;
  limit: number;
  sortByMtime: boolean;
  nocase: boolean;
}

interface GlobEntry {
  path: string;
  mtimeMs: number;
}

export interface FsGlobDependencies {
  /** Wall-clock and scanned-entry ceiling for one walk. */
  budget: WalkBudgetLimits;
  now: () => number;
}

export function buildOsFsGlobTool(
  deps: Partial<FsGlobDependencies> = {},
): ToolDefinition {
  const limits = deps.budget ?? DEFAULT_WALK_BUDGET;
  return {
    name: OS_FS_GLOB_CONTRACT.name,
    description: OS_FS_GLOB_CONTRACT.description,
    readonly: OS_FS_GLOB_CONTRACT.readonly,
    async run(rawArgs, ctx) {
      const args = parseArgs(rawArgs, ctx.workingDir);
      const flags = args.nocase ? "i" : "";
      const matchers = args.patterns.map((p) => compileGlob(p, flags));
      const ignoreMatchers = args.ignore.map((p) => compileGlob(p, flags));
      const fileMatches: GlobEntry[] = [];
      const budget = createWalkBudget(limits, {
        now: deps.now,
        signal: ctx.signal,
      });
      let totalScanned = 0;
      let truncated = false;
      let stopped: WalkStop | null = null;

      async function walk(current: string): Promise<void> {
        if (fileMatches.length >= MAX_FILES_COLLECTED) {
          truncated = true;
          return;
        }
        stopped = budget.check(totalScanned);
        if (stopped !== null) return;
        let entries: Dirent[];
        try {
          entries = (await readdir(current, {
            withFileTypes: true,
          })) as Dirent[];
        } catch {
          return;
        }
        for (const entry of entries) {
          if (fileMatches.length >= MAX_FILES_COLLECTED) {
            truncated = true;
            return;
          }
          stopped = budget.check(totalScanned);
          if (stopped !== null) return;
          const abs = join(current, entry.name);
          const rel = toPosix(relative(args.cwd, abs));
          if (rel.length === 0) continue;
          totalScanned++;
          const isDir = entry.isDirectory();
          const isFile = entry.isFile();
          const relForDir = isDir ? `${rel}/` : rel;
          if (
            matchesAny(ignoreMatchers, rel) ||
            matchesAny(ignoreMatchers, relForDir)
          ) {
            continue;
          }
          if (isFile && matchesAny(matchers, rel)) {
            try {
              const info = await stat(abs);
              fileMatches.push({ path: rel, mtimeMs: info.mtimeMs });
            } catch {
              fileMatches.push({ path: rel, mtimeMs: 0 });
            }
          }
          if (isDir) {
            await walk(abs);
          }
        }
      }

      await walk(args.cwd);
      // The walk's own guard narrows `stopped` to `null` here; re-widen it.
      const stop = stopped as WalkStop | null;
      if (stop !== null) truncated = true;

      if (args.sortByMtime) {
        fileMatches.sort((a, b) => b.mtimeMs - a.mtimeMs);
      } else {
        fileMatches.sort((a, b) => a.path.localeCompare(b.path));
      }
      if (fileMatches.length > args.limit) {
        truncated = true;
      }
      const finalPaths = fileMatches
        .slice(0, args.limit)
        .map((entry) =>
          args.absolute ? resolve(args.cwd, entry.path) : entry.path,
        );
      const summary = finalPaths.join("\n");
      const result = compressToolResult(
        {
          tool: "os.fs.glob",
          status: "ok",
          output: summary.length > 0 ? summary : "(no matches)",
          details: {
            cwd: args.cwd,
            patterns: args.patterns,
            ignore: args.ignore,
            total: fileMatches.length,
            scanned: totalScanned,
            truncated,
            files: finalPaths,
            ...(stop === null
              ? {}
              : {
                  stoppedBy: stop.reason,
                  elapsedMs: stop.elapsedMs,
                  note: describeWalkStop(stop),
                }),
          },
        },
        { maxSummaryLength: 8_000, maxTailLines: 500 },
      );
      if (stop === null) return result;
      // Lead with the note: the compressor keeps the tail of a long list
      // and then the head of that, so a note at either end of `output`
      // can be cut. The model must see that the list is incomplete.
      const note = `${describeWalkStop(stop)}\n`;
      return retainToolOutput(
        result,
        { ...result, summary: `${note}${result.summary}`, truncated: true },
        { prefix: note, truncated: true },
      );
    },
  };
}

export const osFsGlobTool: ToolDefinition = buildOsFsGlobTool();

function parseArgs(
  rawArgs: Record<string, unknown>,
  workingDir: string,
): GlobArgs {
  const patternRaw = rawArgs.pattern;
  const patterns: string[] = [];
  if (typeof patternRaw === "string") {
    if (patternRaw.length === 0) {
      throw new Error("os.fs.glob: `pattern` must be a non-empty string");
    }
    patterns.push(patternRaw);
  } else if (Array.isArray(patternRaw)) {
    for (const p of patternRaw) {
      if (typeof p !== "string" || p.length === 0) {
        throw new Error(
          "os.fs.glob: `pattern[]` entries must be non-empty strings",
        );
      }
      patterns.push(p);
    }
    if (patterns.length === 0) {
      throw new Error(
        "os.fs.glob: `pattern` array must contain at least one pattern",
      );
    }
  } else {
    throw new Error("os.fs.glob: `pattern` is required (string or string[])");
  }
  const cwdExplicit =
    typeof rawArgs.cwd === "string" && rawArgs.cwd.length > 0
      ? rawArgs.cwd
      : null;
  const pathAsRoot =
    typeof rawArgs.path === "string" && rawArgs.path.length > 0
      ? rawArgs.path
      : null;
  const cwdArg = cwdExplicit ?? pathAsRoot ?? workingDir;
  const cwd = resolveUserPath(cwdArg, workingDir);
  const ignore = Array.isArray(rawArgs.ignore)
    ? rawArgs.ignore.filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      )
    : DEFAULT_IGNORE;
  const absolute = rawArgs.absolute === true;
  const limit =
    typeof rawArgs.limit === "number" && Number.isFinite(rawArgs.limit)
      ? Math.max(1, Math.trunc(rawArgs.limit))
      : DEFAULT_LIMIT;
  const sortByMtime = rawArgs.sortByMtime === true;
  const nocase = rawArgs.nocase === true;
  return { patterns, cwd, ignore, absolute, limit, sortByMtime, nocase };
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}
