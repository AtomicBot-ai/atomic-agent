/**
 * The git half of `github.pr.autofix` (ATO-2331): make or refresh the
 * worktree a fix is written in, and push it to the PR head.
 *
 * The worktree sits on a local branch of its own, `pr-autofix/<n>`,
 * so it never collides with the user's checkout of the PR branch (git
 * refuses one branch in two worktrees). The push names the remote
 * target explicitly, `HEAD:refs/heads/<head>`, and never forces: if
 * someone pushed in between, git rejects it and the model must refresh.
 * Precedent: Qwen Code `/autofix-pr` (Apache-2.0) prepares a dedicated
 * PR worktree and pushes from it.
 */

import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { parseGithubRemote, formatRepoSlug, scrubGithubToken } from "../../github/index.js";
import type { GithubRepoRef } from "../../github/index.js";
import { requireBranchName } from "../os/git/git-checkout.js";
import { runGitRemote, type GitRemoteToolOptions } from "../os/git/git-remote-policy.js";
import { runGit } from "../os/git/git-runner.js";

const TOOL = "github.pr.autofix";
const NETWORK_TIMEOUT_MS = 120_000;
const LOCAL_TIMEOUT_MS = 30_000;

export function autofixLocalBranch(number: number): string {
  return `pr-autofix/${number}`;
}

interface Ctx {
  workingDir: string;
  signal: AbortSignal;
}

function fail(what: string, stderr: string): never {
  throw new Error(scrubGithubToken(`${TOOL}: ${what}: ${stderr.trim() || "(no output)"}`));
}

async function git(dir: string, args: string[], ctx: Ctx) {
  return runGit({ workingDir: dir, args, signal: ctx.signal, timeoutMs: LOCAL_TIMEOUT_MS });
}

/** The working directory must be a checkout of the PR's repository. */
export async function requireCheckoutOf(ref: GithubRepoRef, ctx: Ctx): Promise<void> {
  const res = await git(ctx.workingDir, ["remote", "get-url", "--push", "origin"], ctx);
  const origin = res.exitCode === 0 ? parseGithubRemote(res.stdout.trim()) : null;
  const want = formatRepoSlug(ref).toLowerCase();
  if (!origin || formatRepoSlug(origin).toLowerCase() !== want) {
    throw new Error(
      `${TOOL}: the working directory is not a checkout of ${formatRepoSlug(ref)} (its origin is ${origin ? formatRepoSlug(origin) : "missing or not on github.com"}); open that repository first`,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Fetch the PR head and bring the autofix worktree to it: created on
 * first use, fast-forwarded after. A worktree with local commits that
 * diverge from the remote head is reported, not reset.
 */
export async function prepareAutofixWorktree(
  options: GitRemoteToolOptions,
  input: { number: number; headRef: string; dir: string },
  ctx: Ctx,
): Promise<{ dir: string; localBranch: string; headSha: string; created: boolean }> {
  const headRef = requireBranchName(input.headRef, TOOL);
  const remoteRef = `refs/remotes/origin/${headRef}`;
  const fetched = await runGitRemote(options, {
    workingDir: ctx.workingDir,
    args: ["fetch", "--no-tags", "origin", `+refs/heads/${headRef}:${remoteRef}`],
    signal: ctx.signal,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (fetched.exitCode !== 0) fail(`git fetch of ${headRef} failed`, fetched.stderr);

  const localBranch = autofixLocalBranch(input.number);
  const created = !(await exists(input.dir));
  if (created) {
    await mkdir(dirname(input.dir), { recursive: true });
    // A folder deleted by hand leaves git's record behind; drop it first.
    await git(ctx.workingDir, ["worktree", "prune"], ctx);
    const add = await git(
      ctx.workingDir,
      ["worktree", "add", "-B", localBranch, input.dir, remoteRef],
      ctx,
    );
    if (add.exitCode !== 0) fail("git worktree add failed", add.stderr);
  } else {
    // An unfinished base merge (ATO-2516) would block the fast-forward:
    // "prepare" is how the model starts over, so it is dropped first.
    if (await mergeInProgress(input.dir, ctx)) {
      await git(input.dir, ["merge", "--abort"], ctx);
    }
    const ff = await git(input.dir, ["merge", "--ff-only", remoteRef], ctx);
    if (ff.exitCode !== 0) {
      fail(
        `the worktree at ${input.dir} has commits the PR head does not; push them or remove that folder`,
        ff.stderr,
      );
    }
  }
  const head = await git(input.dir, ["rev-parse", "HEAD"], ctx);
  if (head.exitCode !== 0) fail("could not read the worktree HEAD", head.stderr);
  return { dir: input.dir, localBranch, headSha: head.stdout.trim(), created };
}

async function mergeInProgress(dir: string, ctx: Ctx): Promise<boolean> {
  const res = await git(dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], ctx);
  return res.exitCode === 0 && res.stdout.trim().length > 0;
}

export interface BaseMergeResult {
  status: "up-to-date" | "merged" | "conflict";
  /** Files with conflict markers, when `status` is `conflict`. */
  conflicted: string[];
  headSha: string;
}

/**
 * Merge the PR's base branch into the autofix worktree (ATO-2516), the
 * way GitHub's "Update branch" button does. A merge, not a rebase: the
 * result goes on top of the PR head, so the push stays a plain
 * fast-forward and nothing is ever force-pushed. A clean merge is
 * committed here; a conflicted one is left in the worktree for the
 * model to resolve and commit with os.git.commit.
 */
export async function mergeBaseIntoWorktree(
  options: GitRemoteToolOptions,
  input: { dir: string; baseRef: string; headRef: string },
  ctx: Ctx,
): Promise<BaseMergeResult> {
  const baseRef = requireBranchName(input.baseRef, TOOL);
  if (!(await exists(input.dir))) {
    throw new Error(`${TOOL}: no autofix worktree yet; call action "prepare" first`);
  }
  if (await mergeInProgress(input.dir, ctx)) {
    throw new Error(
      `${TOOL}: a merge is already in progress in ${input.dir}; resolve the conflicts and commit (os.git.commit with repo "${input.dir}" and all: true), or call action "prepare" to start over`,
    );
  }
  const status = await git(input.dir, ["status", "--porcelain", "--untracked-files=no"], ctx);
  if (status.exitCode !== 0) fail("git status failed", status.stderr);
  if (status.stdout.trim().length > 0) {
    throw new Error(`${TOOL}: the worktree has uncommitted changes; commit or drop them before merging ${baseRef}`);
  }
  const remoteRef = `refs/remotes/origin/${baseRef}`;
  const fetched = await runGitRemote(options, {
    workingDir: input.dir,
    args: ["fetch", "--no-tags", "origin", `+refs/heads/${baseRef}:${remoteRef}`],
    signal: ctx.signal,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (fetched.exitCode !== 0) fail(`git fetch of ${baseRef} failed`, fetched.stderr);

  const before = await git(input.dir, ["rev-parse", "HEAD"], ctx);
  const merge = await git(
    input.dir,
    ["-c", "commit.gpgsign=false", "merge", "--no-edit", "-m", `Merge branch '${baseRef}' into ${input.headRef}`, remoteRef],
    ctx,
  );
  const after = await git(input.dir, ["rev-parse", "HEAD"], ctx);
  const headSha = after.stdout.trim();
  if (merge.exitCode === 0) {
    return { status: headSha === before.stdout.trim() ? "up-to-date" : "merged", conflicted: [], headSha };
  }
  const unmerged = await git(input.dir, ["diff", "--name-only", "--diff-filter=U"], ctx);
  const conflicted = unmerged.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (conflicted.length === 0) {
    // Not a conflict (identity missing, a hook refused): leave nothing half done.
    await git(input.dir, ["merge", "--abort"], ctx);
    fail(`merging ${baseRef} failed`, merge.stderr || merge.stdout);
  }
  return { status: "conflict", conflicted, headSha };
}

/** What a push would send, checked before anyone is asked to approve it. */
export async function inspectAutofixWorktree(
  input: { number: number; dir: string },
  ctx: Ctx,
): Promise<{ headSha: string }> {
  if (!(await exists(input.dir))) {
    throw new Error(`${TOOL}: no autofix worktree yet; call action "prepare" first`);
  }
  const branch = await git(input.dir, ["symbolic-ref", "--short", "-q", "HEAD"], ctx);
  const want = autofixLocalBranch(input.number);
  if (branch.exitCode !== 0 || branch.stdout.trim() !== want) {
    throw new Error(
      `${TOOL}: the worktree at ${input.dir} is not on ${want} (found ${branch.stdout.trim() || "a detached HEAD"}); call action "prepare" again`,
    );
  }
  const status = await git(input.dir, ["status", "--porcelain", "--untracked-files=no"], ctx);
  if (status.exitCode !== 0) fail("git status failed", status.stderr);
  if (status.stdout.trim().length > 0) {
    throw new Error(
      `${TOOL}: the worktree has uncommitted changes; commit the fix first (os.git.commit with repo "${input.dir}")`,
    );
  }
  const head = await git(input.dir, ["rev-parse", "HEAD"], ctx);
  if (head.exitCode !== 0) fail("could not read the worktree HEAD", head.stderr);
  return { headSha: head.stdout.trim() };
}

/** `git push origin HEAD:refs/heads/<target>`: no force, no other ref. */
export function autofixPushArgs(target: string): string[] {
  return ["push", "origin", `HEAD:refs/heads/${requireBranchName(target, TOOL)}`];
}

export async function pushAutofixWorktree(
  options: GitRemoteToolOptions,
  input: { dir: string; target: string },
  ctx: Ctx,
): Promise<string> {
  const res = await runGitRemote(options, {
    workingDir: input.dir,
    args: autofixPushArgs(input.target),
    signal: ctx.signal,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (res.exitCode !== 0) {
    fail(
      `git push to ${input.target} was rejected (if the branch moved, call action "prepare" again)`,
      res.stderr,
    );
  }
  return res.stderr.trim() || `pushed to ${input.target}`;
}
