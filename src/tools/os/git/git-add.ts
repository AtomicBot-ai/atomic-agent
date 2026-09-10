import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import type { FsDangerousToolOptions } from "../fs-require-approval.js";
import { buildGitErrorResult, describeGitFailure } from "./git-error-result.js";
import {
  formatGitCommandLine,
  requireGitMutationApproval,
} from "./git-mutation-approval.js";
import { hasHeadCommit, resolveGitToplevel } from "./git-repo-probe.js";
import { runGit } from "./git-runner.js";
import { parsePorcelain, type GitStatusEntry } from "./git-status.js";

const TOOL = "os.git.add";
const MAX_LISTED_PATHS = 20;

interface AddArgs {
  repo?: string;
  paths: string[];
  all: boolean;
  unstage: boolean;
}

export interface GitIndexCounts {
  staged: number;
  unstaged: number;
  untracked: number;
}

/**
 * `os.git.add` — stage or unstage changes. Paths are relative to the
 * session working dir (or `repo`), exactly like the read tools.
 */
export function buildOsGitAddTool(
  options: FsDangerousToolOptions,
): ToolDefinition {
  return {
    name: TOOL,
    description:
      "Stage changes: `all: true` runs `git add -A`, `paths` runs `git add -- <paths>`. `unstage: true` reverses it (`git restore --staged`). One of `all` / `paths` is required. Requires approval like a file write in the repository.",
    readonly: false,
    async run(rawArgs, ctx) {
      const parsed = parseArgs(rawArgs);
      if (!parsed.ok) return buildGitErrorResult(TOOL, parsed.message);
      const args = parsed.value;
      const probe = { repo: args.repo, workingDir: ctx.workingDir, signal: ctx.signal };

      const toplevel = await resolveGitToplevel(probe);
      if (!toplevel.ok) return buildGitErrorResult(TOOL, `${TOOL}: ${toplevel.message}`);
      const unborn = !(await hasHeadCommit(probe));
      const gitArgs = buildGitArgs(args, unborn);

      await requireGitMutationApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: TOOL,
          repoRoot: toplevel.root,
          reason: `git ${args.unstage ? "unstage" : "add"} in ${toplevel.root}`,
          preview: formatGitCommandLine(gitArgs),
          workingDir: ctx.workingDir,
          trustConfigPaths: options.trustConfigPaths,
        },
        ctx.signal,
      );

      const result = await runGit({ ...probe, args: gitArgs });
      if (result.exitCode !== 0) {
        return buildGitErrorResult(TOOL, describeGitFailure(result), {
          repoRoot: toplevel.root,
        });
      }

      const status = await runGit({
        ...probe,
        args: ["status", "--porcelain=v1", "-z"],
      });
      if (status.exitCode !== 0) {
        return buildGitErrorResult(TOOL, describeGitFailure(status), {
          repoRoot: toplevel.root,
        });
      }
      const { entries } = parsePorcelain(status.stdout);
      const counts = countIndex(entries);
      const staged = entries.filter(isStaged).map((e) => e.path);

      return compressToolResult({
        tool: TOOL,
        status: "ok",
        output: formatOutput(args, toplevel.root, counts, staged),
        details: {
          repoRoot: toplevel.root,
          action: args.unstage ? "unstage" : "add",
          all: args.all,
          paths: args.paths,
          unborn,
          counts,
          staged,
        },
      });
    },
  };
}

function parseArgs(
  rawArgs: Record<string, unknown>,
): { ok: true; value: AddArgs } | { ok: false; message: string } {
  const repo = typeof rawArgs.repo === "string" && rawArgs.repo.length > 0
    ? rawArgs.repo
    : undefined;
  const all = rawArgs.all === true;
  const unstage = rawArgs.unstage === true;
  const rawPaths = rawArgs.paths;
  let paths: string[] = [];
  if (rawPaths !== undefined && rawPaths !== null) {
    if (
      !Array.isArray(rawPaths) ||
      !rawPaths.every((p) => typeof p === "string" && p.trim().length > 0)
    ) {
      return {
        ok: false,
        message: `${TOOL}: \`paths\` must be an array of non-empty strings`,
      };
    }
    paths = rawPaths.map((p: string) => p.trim());
  }
  if (all && paths.length > 0) {
    return {
      ok: false,
      message: `${TOOL}: pass either \`all: true\` or \`paths\`, not both`,
    };
  }
  if (!all && paths.length === 0) {
    return {
      ok: false,
      message: `${TOOL}: nothing selected — pass \`all: true\` to ${unstage ? "unstage" : "stage"} everything, or \`paths: [...]\` for specific files`,
    };
  }
  const value: AddArgs = { paths, all, unstage };
  if (repo !== undefined) value.repo = repo;
  return { ok: true, value };
}

/**
 * Staging is `git add`; unstaging is `git restore --staged` once the
 * branch has a commit. On an unborn branch there is no HEAD to restore
 * from, so `git reset -q [-- <paths>]` is used instead — it empties the
 * index entries without needing a commit and, unlike `git rm --cached`,
 * does not fail when the index is already empty.
 */
function buildGitArgs(args: AddArgs, unborn: boolean): string[] {
  const pathspec = args.all ? [] : ["--", ...args.paths];
  if (!args.unstage) {
    return args.all ? ["add", "-A"] : ["add", ...pathspec];
  }
  if (unborn) return ["reset", "-q", ...pathspec];
  return args.all ? ["reset", "-q"] : ["restore", "--staged", ...pathspec];
}

function isStaged(entry: GitStatusEntry): boolean {
  return entry.indexStatus !== " " && entry.indexStatus !== "?" && entry.indexStatus !== "!";
}

function isUnstaged(entry: GitStatusEntry): boolean {
  return entry.workingStatus !== " " && entry.workingStatus !== "?" && entry.workingStatus !== "!";
}

function countIndex(entries: readonly GitStatusEntry[]): GitIndexCounts {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const entry of entries) {
    if (entry.indexStatus === "?") {
      untracked++;
      continue;
    }
    if (isStaged(entry)) staged++;
    if (isUnstaged(entry)) unstaged++;
  }
  return { staged, unstaged, untracked };
}

function formatOutput(
  args: AddArgs,
  root: string,
  counts: GitIndexCounts,
  staged: readonly string[],
): string {
  const what = args.all ? "all changes" : `${args.paths.length} path(s)`;
  const lines = [
    `${args.unstage ? "unstaged" : "staged"} ${what} in ${root}`,
    `index: ${counts.staged} staged, ${counts.unstaged} modified (unstaged), ${counts.untracked} untracked`,
  ];
  for (const path of staged.slice(0, MAX_LISTED_PATHS)) lines.push(`  staged: ${path}`);
  if (staged.length > MAX_LISTED_PATHS) {
    lines.push(`  … ${staged.length - MAX_LISTED_PATHS} more staged`);
  }
  return lines.join("\n");
}
