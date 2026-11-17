/* ATO-576 — the git half of "New chat in its own branch" (chat-worktree-ipc.ts).

   The same layout and the same safety rules as the agent's `/new worktree`
   (src/session/session-worktree.ts), so the terminal and the desktop share
   one folder of worktrees: `<stateDir>/worktrees/<repo>-<hash>/<name>` on a
   branch `atomic/session-<name>` cut from the project's HEAD. Removal is
   `git worktree remove` without `--force` and `git branch -d`, and is
   refused on any uncommitted, untracked or ignored file other than a
   rebuildable cache: `git worktree remove` deletes ignored files.

   Pure apart from the `GitExec` it is handed, so the suite drives it with a
   fake git (test/chat-worktree.test.mjs). */

import { createHash } from "node:crypto";
import { basename, join, relative, sep } from "node:path";

export interface GitResult { code: number; stdout: string; stderr: string }
/** Runs git in `cwd`; null when git could not be started at all. */
export type GitExec = (args: string[], cwd: string) => Promise<GitResult | null>;

const ok = (r: GitResult | null): r is GitResult => r !== null && r.code === 0;

/** `<name>-<8 hex of sha1(root)>`, as the agent names a repository's folder. */
export function repoKey(repoRoot: string): string {
  const hash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 8);
  const name = basename(repoRoot).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "repo";
  return `${name}-${hash}`;
}

/** Short, branch- and path-safe name for a chat id (`s-1a2b…` / a uuid → `1a2b3c4d`). */
export function worktreeName(chatId: string): string {
  return chatId.replace(/^s-/, "").replace(/[^A-Za-z0-9]+/g, "").slice(0, 8) || "session";
}

/** The project's subfolder inside the worktree (a project may be a subfolder of its repository). */
export function dirInWorktree(repoRoot: string, projectDir: string, worktreePath: string): string {
  const rel = relative(repoRoot, projectDir);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) return worktreePath;
  return join(worktreePath, rel);
}

export interface PorcelainWorktree { path: string; head: string; branch: string | null; locked: boolean; prunable: boolean }

/** `git worktree list --porcelain`, one record per blank-line block. */
export function parseWorktreePorcelain(stdout: string): PorcelainWorktree[] {
  const out: PorcelainWorktree[] = [];
  for (const block of String(stdout || "").split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    const first = lines[0];
    if (!first || !first.startsWith("worktree ")) continue;
    const rec: PorcelainWorktree = { path: first.slice("worktree ".length), head: "", branch: null, locked: false, prunable: false };
    for (const l of lines.slice(1)) {
      if (l.startsWith("HEAD ")) rec.head = l.slice(5);
      else if (l.startsWith("branch ")) rec.branch = l.slice(7).replace(/^refs\/heads\//, "");
      else if (l === "locked" || l.startsWith("locked ")) rec.locked = true;
      else if (l === "prunable" || l.startsWith("prunable ")) rec.prunable = true;
    }
    out.push(rec);
  }
  return out;
}

/** Is `p` strictly inside `dir` (both already resolved)? Case-folded on Windows and macOS. */
export function isInside(dir: string, p: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (s: string): string => {
    const x = s.replace(/\\/g, "/").replace(/\/+$/, "");
    return platform === "win32" || platform === "darwin" ? x.toLowerCase() : x;
  };
  const d = norm(dir), q = norm(p);
  return q.length > d.length + 1 && q.startsWith(`${d}/`);
}

/** Ignored names a tool rebuilds; anything else ignored keeps the worktree (as the agent's list). */
export const REGENERABLE_IGNORED = new Set(["node_modules", ".turbo", ".parcel-cache", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".DS_Store"]);

/** Why the worktree may not be removed, from `git status --porcelain -z --ignored=matching`; null when it may. */
export function dirtyReason(statusZ: string): string | null {
  const entries = String(statusZ || "").split("\0").filter((e) => e !== "");
  if (entries.some((e) => !e.startsWith("!! "))) return "It has changes nobody committed.";
  const kept = entries.map((e) => e.slice(3)).filter((p) => !p.split("/").some((part) => REGENERABLE_IGNORED.has(part)));
  if (kept.length) return `It has ignored files that removing would delete: ${kept.slice(0, 3).join(", ")}${kept.length > 3 ? ", …" : ""}.`;
  return null;
}

export const NOT_GIT = "This project's folder is not inside a git repository, so it cannot have a branch of its own.";

export interface NewWorktree { repoRoot: string; path: string; branch: string; baseBranch: string | null; baseCommit: string }

/** `git worktree add -b atomic/session-<name> <dir> HEAD` from the repository holding `projectDir`. */
export async function addWorktree(
  git: GitExec, projectDir: string, worktreesDir: string, chatId: string,
  exists: (p: string) => boolean, realpath: (p: string) => Promise<string>, mkdirp: (p: string) => Promise<void>,
): Promise<NewWorktree | { error: string }> {
  const top = await git(["rev-parse", "--show-toplevel"], projectDir);
  if (top === null) return { error: "git is not installed on this computer." };
  if (!ok(top) || !top.stdout.trim()) return { error: NOT_GIT };
  const repoRoot = await realpath(top.stdout.trim());
  const head = await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"], repoRoot);
  if (!ok(head)) return { error: "This repository has no commit yet, so there is nothing to branch from. Make a first commit, then try again." };
  const baseCommit = head.stdout.trim();
  const sym = await git(["symbolic-ref", "--short", "-q", "HEAD"], repoRoot);
  const baseBranch = ok(sym) && sym.stdout.trim() ? sym.stdout.trim() : null;
  const parent = join(worktreesDir, repoKey(repoRoot));
  await mkdirp(parent);
  const name = worktreeName(chatId);
  let branch = `atomic/session-${name}`;
  let path = join(parent, name);
  for (let n = 2; exists(path) || ok(await git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], repoRoot)); n++) {
    if (n > 20) return { error: `No free branch name for ${name}.` };
    branch = `atomic/session-${name}-${n}`;
    path = join(parent, `${name}-${n}`);
  }
  const added = await git(["worktree", "add", "-b", branch, path, baseCommit], repoRoot);
  if (!ok(added)) return { error: `git worktree add failed: ${(added?.stderr || "").trim().split("\n").at(-1) || "unknown error"}` };
  return { repoRoot, path: await realpath(path), branch, baseBranch, baseCommit };
}
