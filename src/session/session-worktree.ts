/**
 * A git worktree per session (ATO-576).
 *
 * Opt-in: `/new worktree` starts a session whose working directory is a
 * fresh `git worktree` on a branch of its own, so two sessions editing
 * the same project do not write into each other's files. Only inside a
 * git repository; anywhere else the start is refused with a message
 * that says why, and nothing is created.
 *
 * The binding (repo, worktree path, branch, base) is stored on the
 * session itself (`SessionState.worktree`), and a small marker file next
 * to the worktree (`<path>.json`) lets the cleanup find worktrees whose
 * session was deleted. The marker lives outside the worktree on purpose:
 * a file inside it would show up as an uncommitted change.
 *
 * Removal always goes through {@link worktreeRemovalPreflight}: a
 * worktree with uncommitted or untracked changes is never removed, and
 * git itself is called without `--force`, so it refuses a dirty or
 * locked worktree a second time. The branch is deleted with `-d`, which
 * git refuses for unmerged work.
 *
 * Fusion workers have their own per-task worktrees
 * (`tools/fusion/branch-workspace.ts`, ATO-946); this module is only the
 * per-session one.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { runCommand, type CommandResult } from "../sandbox/command-runner.js";
import { buildCommandEnv } from "../sandbox/command-env.js";
import type { SessionState } from "./session-state.js";

export interface SessionWorktreeBinding {
  /** Top level of the repository the worktree was made from. */
  repoRoot: string;
  /** The folder the session would have used without a worktree (may be a subfolder of `repoRoot`). */
  originalWorkingDir: string;
  /** Top level of the worktree. */
  path: string;
  branch: string;
  /** Branch checked out in `repoRoot` when the worktree was made; `null` when HEAD was detached. */
  baseBranch: string | null;
  baseCommit: string;
  createdAt: number;
}

export interface SessionWorktreeMarker extends SessionWorktreeBinding {
  sessionId: string;
}

export type SessionWorktreeErrorCode = "not-git" | "git-missing" | "no-commit" | "failed";

export class SessionWorktreeError extends Error {
  constructor(readonly code: SessionWorktreeErrorCode, message: string) {
    super(message);
    this.name = "SessionWorktreeError";
  }
}

/** Runs git; `null` when git could not be started at all. Test seam. */
export type SessionGitExec = (args: string[], cwd: string) => Promise<CommandResult | null>;

export const defaultSessionGitExec: SessionGitExec = async (args, cwd) => {
  try {
    // No hooks, as for the Fusion worktrees: a checkout hook would run code nobody approved.
    return await runCommand("git", ["--no-pager", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      env: { ...buildCommandEnv(process.env), GIT_PAGER: "", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      timeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
    });
  } catch {
    return null;
  }
};

export interface SessionWorktreeOptions {
  /** Folder that holds every session worktree, e.g. `<stateDir>/worktrees`. */
  worktreesDir: string;
  exec?: SessionGitExec;
  now?: () => number;
}

export const NOT_GIT_MESSAGE =
  "This folder is not inside a git repository, so the session cannot get its own worktree. " +
  "Open a git project (or run `git init` and make a first commit), or use /new for a normal session.";

function succeeded(result: CommandResult | null): result is CommandResult {
  return result !== null && result.exitCode === 0 && !result.timedOut;
}

function gitError(what: string, result: CommandResult | null): SessionWorktreeError {
  if (result === null) return new SessionWorktreeError("git-missing", "git was not found on PATH. Install Git to use worktree sessions.");
  const detail = result.timedOut ? "timed out" : result.stderr.trim() || `exit code ${result.exitCode}`;
  return new SessionWorktreeError("failed", `${what} failed: ${detail}`);
}

/** Top level of the repository containing `dir`, or `null` when it is not in one. */
export async function findRepoRoot(dir: string, exec: SessionGitExec = defaultSessionGitExec): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const result = await exec(["rev-parse", "--show-toplevel"], dir);
  if (result === null) throw gitError("git rev-parse", null);
  if (!succeeded(result)) return null;
  const top = result.stdout.trim();
  return top ? realpath(top) : null;
}

function repoKey(repoRoot: string): string {
  const hash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 8);
  const name = basename(repoRoot).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "repo";
  return `${name}-${hash}`;
}

/** Short, branch- and path-safe name for a session id (`s-1a2b…` → `1a2b3c4d`). */
export function sessionWorktreeName(sessionId: string): string {
  const cleaned = sessionId.replace(/^s-/, "").replace(/[^A-Za-z0-9]+/g, "").slice(0, 8);
  return cleaned || "session";
}

export function markerPathFor(worktreePath: string): string {
  return `${worktreePath}.json`;
}

/**
 * Make a worktree for `sessionId` from the repository that contains
 * `workingDir`. Throws {@link SessionWorktreeError}; `code: "not-git"`
 * carries {@link NOT_GIT_MESSAGE}.
 */
export async function createSessionWorktree(
  sessionId: string,
  workingDir: string,
  options: SessionWorktreeOptions,
): Promise<{ binding: SessionWorktreeBinding; sessionDir: string }> {
  const exec = options.exec ?? defaultSessionGitExec;
  const repoRoot = await findRepoRoot(workingDir, exec);
  if (repoRoot === null) throw new SessionWorktreeError("not-git", NOT_GIT_MESSAGE);
  const head = await exec(["rev-parse", "--verify", "-q", "HEAD^{commit}"], repoRoot);
  if (!succeeded(head)) {
    throw new SessionWorktreeError("no-commit", "This repository has no commit yet, so there is nothing to branch from. Make a first commit, then try again.");
  }
  const baseCommit = head.stdout.trim();
  const symbolic = await exec(["symbolic-ref", "--short", "-q", "HEAD"], repoRoot);
  const baseBranch = succeeded(symbolic) && symbolic.stdout.trim() ? symbolic.stdout.trim() : null;

  const parent = join(options.worktreesDir, repoKey(repoRoot));
  await mkdir(parent, { recursive: true });
  const name = sessionWorktreeName(sessionId);
  let branch = `atomic/session-${name}`;
  let path = join(parent, name);
  for (let attempt = 2; existsSync(path) || succeeded(await exec(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], repoRoot)); attempt++) {
    if (attempt > 20) throw new SessionWorktreeError("failed", `could not find a free branch name for ${name}`);
    branch = `atomic/session-${name}-${attempt}`;
    path = join(parent, `${name}-${attempt}`);
  }
  const added = await exec(["worktree", "add", "-b", branch, path, baseCommit], repoRoot);
  if (!succeeded(added)) throw gitError("git worktree add", added);

  const realPath = await realpath(path);
  const originalWorkingDir = await realpath(workingDir);
  const binding: SessionWorktreeBinding = {
    repoRoot, originalWorkingDir, path: realPath, branch, baseBranch, baseCommit,
    createdAt: (options.now ?? Date.now)(),
  };
  const marker: SessionWorktreeMarker = { ...binding, sessionId };
  await writeFile(markerPathFor(realPath), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return { binding, sessionDir: sessionDirFor(binding) };
}

/** The session's working directory inside the worktree: the same subfolder it started in. */
export function sessionDirFor(binding: SessionWorktreeBinding): string {
  const rel = relative(binding.repoRoot, binding.originalWorkingDir);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) return binding.path;
  return join(binding.path, rel);
}

/** A copy of `session` that works inside a new worktree. The caller saves it. */
export async function bindSessionWorktree(session: SessionState, options: SessionWorktreeOptions): Promise<SessionState> {
  const base = session.worktree?.originalWorkingDir ?? session.workingDir;
  const { binding, sessionDir } = await createSessionWorktree(session.id, base, options);
  return { ...session, workingDir: sessionDir, worktree: binding, updatedAt: Date.now() };
}

/** A copy of `session` pointed back at its original folder, without the binding. */
export function unbindSessionWorktree(session: SessionState): SessionState {
  if (!session.worktree) return session;
  const { worktree, ...rest } = session;
  return { ...rest, workingDir: worktree.originalWorkingDir, updatedAt: Date.now() };
}

export type RemovalPreflight =
  | { ok: true; missing: boolean }
  | { ok: false; reason: string };

/**
 * May this worktree be removed? Refuses on any uncommitted or untracked
 * change, on a path git does not list as a worktree of the repository,
 * and when git cannot answer.
 */
export async function worktreeRemovalPreflight(
  binding: SessionWorktreeBinding,
  exec: SessionGitExec = defaultSessionGitExec,
): Promise<RemovalPreflight> {
  if (!existsSync(binding.path)) return { ok: true, missing: true };
  const listed = await exec(["worktree", "list", "--porcelain"], binding.repoRoot);
  if (!succeeded(listed)) return { ok: false, reason: "git could not list the repository's worktrees" };
  const paths = listed.stdout.split("\n").filter(l => l.startsWith("worktree ")).map(l => l.slice("worktree ".length));
  const resolved = await Promise.all(paths.map(p => realpath(p).catch(() => p)));
  if (!resolved.includes(binding.path)) return { ok: false, reason: "git does not list this folder as a worktree of the repository" };
  const status = await exec(["status", "--porcelain", "--untracked-files=normal"], binding.path);
  if (!succeeded(status)) return { ok: false, reason: "git status failed in the worktree" };
  if (status.stdout.trim() !== "") return { ok: false, reason: "the worktree has uncommitted changes" };
  return { ok: true, missing: false };
}

/** Is the session branch fully contained in its base (so deleting it loses no commit)? */
export async function isWorktreeBranchMerged(
  binding: SessionWorktreeBinding,
  exec: SessionGitExec = defaultSessionGitExec,
): Promise<boolean> {
  const exists = await exec(["rev-parse", "--verify", "-q", `refs/heads/${binding.branch}`], binding.repoRoot);
  // A branch someone already deleted holds nothing that could be lost.
  if (exists !== null && exists.exitCode === 1 && !exists.timedOut) return true;
  const target = binding.baseBranch ? `refs/heads/${binding.baseBranch}` : binding.baseCommit;
  const result = await exec(["merge-base", "--is-ancestor", `refs/heads/${binding.branch}`, target], binding.repoRoot);
  return succeeded(result);
}

/**
 * Remove a worktree after the preflight passes, then delete its branch
 * with `git branch -d` and the marker. Returns the refusal reason, or
 * `null` when the worktree is gone.
 */
export async function removeSessionWorktree(
  binding: SessionWorktreeBinding,
  exec: SessionGitExec = defaultSessionGitExec,
): Promise<string | null> {
  const preflight = await worktreeRemovalPreflight(binding, exec);
  if (!preflight.ok) return preflight.reason;
  if (!preflight.missing) {
    const removed = await exec(["worktree", "remove", binding.path], binding.repoRoot);
    if (!succeeded(removed)) return `git worktree remove refused: ${removed?.stderr.trim() || "unknown error"}`;
  }
  await exec(["worktree", "prune"], binding.repoRoot);
  // `-d`, never `-D`: git keeps a branch that has commits nobody merged.
  await exec(["branch", "-d", binding.branch], binding.repoRoot);
  await rm(markerPathFor(binding.path), { force: true });
  return null;
}

/** Every marker under `worktreesDir`; unreadable ones are skipped. */
export async function listSessionWorktreeMarkers(worktreesDir: string): Promise<SessionWorktreeMarker[]> {
  const markers: SessionWorktreeMarker[] = [];
  const repos = await readdir(worktreesDir, { withFileTypes: true }).catch(() => []);
  for (const repo of repos) {
    if (!repo.isDirectory()) continue;
    const dir = join(worktreesDir, repo.name);
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(dir, file), "utf8")) as Partial<SessionWorktreeMarker>;
        if (typeof parsed.sessionId === "string" && typeof parsed.path === "string" && typeof parsed.repoRoot === "string"
          && typeof parsed.branch === "string" && typeof parsed.baseCommit === "string") {
          markers.push(parsed as SessionWorktreeMarker);
        }
      } catch {
        // A marker we cannot read is left alone: no guess about what it guarded.
      }
    }
  }
  return markers;
}
