import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { requireGitSuccess, runGit } from "./git-runner.js";

/**
 * Minimal representation of a branch; exposes enough for the agent to
 * reason about local/remote topology without dragging in upstream
 * tracking metadata (which would double the output for little value).
 */
export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  hash: string;
  subject: string;
}

export const osGitBranchTool: ToolDefinition = {
  name: "os.git.branch",
  description:
    "List branches. Args (all optional): `includeRemote` (default false), `contains` (commit-ish — filter branches containing the commit), `pattern` (shell-glob filter applied by git).",
  readonly: true,
  async run(rawArgs, ctx) {
    const repo = typeof rawArgs.repo === "string" ? rawArgs.repo : undefined;
    const includeRemote = rawArgs.includeRemote === true;
    const contains =
      typeof rawArgs.contains === "string" && rawArgs.contains.length > 0
        ? rawArgs.contains
        : undefined;
    const pattern =
      typeof rawArgs.pattern === "string" && rawArgs.pattern.length > 0
        ? rawArgs.pattern
        : undefined;

    // for-each-ref gives stable machine-readable output. We pick a
    // delimited format instead of JSON because older git versions
    // don't speak `--format=json`.
    // Include the full refname up front so we can reliably tell local
    // branches apart from remote ones, then the short display name, the
    // commit hash, and finally the subject line.
    const format =
      "%(refname)%00%(refname:short)%00%(objectname)%00%(contents:subject)";
    const args: string[] = [
      "for-each-ref",
      "--format",
      format,
    ];
    if (contains) args.push(`--contains=${contains}`);
    args.push("refs/heads");
    if (includeRemote) args.push("refs/remotes");

    const [refsResult, currentResult] = await Promise.all([
      runGit({
        repo,
        workingDir: ctx.workingDir,
        args,
        signal: ctx.signal,
      }),
      runGit({
        repo,
        workingDir: ctx.workingDir,
        args: ["symbolic-ref", "--short", "-q", "HEAD"],
        signal: ctx.signal,
        timeoutMs: 5_000,
      }),
    ]);
    requireGitSuccess("os.git.branch", refsResult);
    const currentBranch = currentResult.stdout.trim() || null;

    let branches = parseBranches(refsResult.stdout, currentBranch);
    if (pattern) {
      const re = globToRegExp(pattern);
      branches = branches.filter((b) => re.test(b.name));
    }

    return compressToolResult({
      tool: "os.git.branch",
      status: "ok",
      output: formatBranches(branches, currentBranch),
      details: {
        currentBranch,
        includeRemote,
        contains: contains ?? null,
        pattern: pattern ?? null,
        count: branches.length,
        branches,
        repoRoot: refsResult.repoRoot,
      },
    });
  },
};

function parseBranches(
  stdout: string,
  currentBranch: string | null,
): GitBranch[] {
  const out: GitBranch[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw) continue;
    const parts = raw.split("\x00");
    if (parts.length < 4) continue;
    const [fullRef, name, hash, subject] = parts as [
      string,
      string,
      string,
      string,
    ];
    if (!name) continue;
    // Silence noise like `origin/HEAD` that points at another ref.
    if (name.endsWith("/HEAD")) continue;
    const isRemote = fullRef.startsWith("refs/remotes/");
    const isCurrent =
      !isRemote && currentBranch !== null && name === currentBranch;
    out.push({ name, isCurrent, isRemote, hash, subject });
  }
  return out;
}

function formatBranches(
  branches: readonly GitBranch[],
  currentBranch: string | null,
): string {
  const lines: string[] = [];
  if (currentBranch) lines.push(`# current: ${currentBranch}`);
  else lines.push("# current: (detached)");
  for (const b of branches) {
    const mark = b.isCurrent ? "*" : " ";
    lines.push(`${mark} ${b.name}  ${b.hash.slice(0, 12)}  ${b.subject}`);
  }
  return lines.join("\n");
}

/**
 * Translate a simple shell glob (`*`, `?`) to a regex anchored at both
 * ends. We intentionally don't support `[...]` classes because the
 * resulting regex grows a surprise surface — users who need that can
 * pre-filter via `git for-each-ref --sort` instead.
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${withWildcards}$`);
}
