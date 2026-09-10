import { runGit } from "./git-runner.js";

/**
 * Read-only probes of repository state that the write tools need before
 * they mutate anything: where the repository actually is, whether it has
 * a commit yet, and what HEAD points at. Kept separate from the verbs so
 * each tool file stays about its own command.
 */

export interface GitProbeOptions {
  /** Repo root or a path inside a repo; omitted means the working dir. */
  repo?: string | undefined;
  workingDir: string;
  signal: AbortSignal;
}

export type GitToplevelResult =
  | { ok: true; root: string }
  | { ok: false; message: string };

/**
 * Resolve the toplevel of the repository containing `repo` (or the
 * working dir). Write tools categorise, describe and report against the
 * toplevel rather than the directory the model named: a commit records
 * into `<toplevel>/.git` even when the session cwd is a subdirectory,
 * so that is the path the operator is asked to approve.
 */
export async function resolveGitToplevel(
  options: GitProbeOptions,
): Promise<GitToplevelResult> {
  const result = await runGit({
    repo: options.repo,
    workingDir: options.workingDir,
    args: ["rev-parse", "--show-toplevel"],
    signal: options.signal,
    timeoutMs: 5_000,
  });
  const root = result.stdout.trim();
  if (result.exitCode !== 0 || root.length === 0) {
    const stderr = result.stderr.trim();
    return {
      ok: false,
      message: stderr || `not a git repository: ${result.repoRoot}`,
    };
  }
  return { ok: true, root };
}

/**
 * True once the current branch has a commit. An unborn branch (fresh
 * `git init`) has no HEAD to resolve, which changes how unstaging works.
 */
export async function hasHeadCommit(options: GitProbeOptions): Promise<boolean> {
  const result = await runGit({
    repo: options.repo,
    workingDir: options.workingDir,
    args: ["rev-parse", "--verify", "-q", "HEAD"],
    signal: options.signal,
    timeoutMs: 5_000,
  });
  return result.exitCode === 0;
}

export interface GitHeadInfo {
  /** Current branch, or `null` when HEAD is detached or unborn. */
  branch: string | null;
  /** Full HEAD hash, or `null` on an unborn branch. */
  hash: string | null;
  shortHash: string | null;
}

/** What HEAD points at right now: branch name (if any) and commit hash. */
export async function describeHead(
  options: GitProbeOptions,
): Promise<GitHeadInfo> {
  const [branchResult, hashResult] = await Promise.all([
    runGit({
      repo: options.repo,
      workingDir: options.workingDir,
      args: ["symbolic-ref", "--short", "-q", "HEAD"],
      signal: options.signal,
      timeoutMs: 5_000,
    }),
    runGit({
      repo: options.repo,
      workingDir: options.workingDir,
      args: ["rev-parse", "--verify", "-q", "HEAD"],
      signal: options.signal,
      timeoutMs: 5_000,
    }),
  ]);
  const branch = branchResult.stdout.trim();
  const hash = hashResult.exitCode === 0 ? hashResult.stdout.trim() : "";
  return {
    branch: branch.length > 0 ? branch : null,
    hash: hash.length > 0 ? hash : null,
    shortHash: hash.length > 0 ? hash.slice(0, 7) : null,
  };
}
