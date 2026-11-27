/**
 * ATO-2445: what git says about the files the project tree shows
 * (project-tree.ts): whether the folder is in a checkout, which names
 * .gitignore leaves out, and each changed file's status.
 *
 * Every call is execFile with fixed arguments (no shell), in the chat's
 * folder, with mention-git.ts's GIT_SAFE_PREFIX in front (no fsmonitor hook,
 * no index write) and without inherited GIT_DIR and friends, a time limit and
 * an output cap. `git check-ignore` answers exit code 1 when nothing is
 * ignored; that is an answer here, not a failure. Its paths go on stdin
 * (`--stdin -z`: git refuses `-z` without `--stdin`, and stdin has no
 * command-line length limit, which Windows puts near 32k).
 *
 * No Electron import, so the unit suite loads it from `out/main`.
 */

import { execFile } from "node:child_process";

import { GIT_MAX_OUTPUT, GIT_SAFE_PREFIX, GIT_TIMEOUT_MS } from "./mention-git.js";

/** One file's state, as the tree shows it (VS Code's letters). */
export type GitMark = "M" | "A" | "D" | "R" | "U" | "C";

/** Runs git; `input`, when given, is written to its stdin. */
export type Git = (cwd: string, args: readonly string[], input?: string) => Promise<{ code: number; out: string }>;

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
  return env;
}

/** git with its exit code; a git that is not there, or ran past its time, rejects. */
export const runGitCode: Git = (cwd, args, input) =>
  new Promise((done, fail) => {
    const child = execFile(
      "git", [...GIT_SAFE_PREFIX, ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT, windowsHide: true, encoding: "utf8", env: gitEnv() },
      (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (!error) return done({ code: 0, out: String(stdout) });
        if (typeof code === "number") return done({ code, out: String(stdout) });
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return done({ code: 0, out: String(stdout) });
        fail(error);
      },
    );
    // A git that dies early closes its stdin; the exit code above is the answer.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });

/** The folder's place in its checkout (`sub/dir/`, `` at the top), or null outside one. */
export async function gitPrefix(git: Git, cwd: string): Promise<string | null> {
  try {
    const r = await git(cwd, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]);
    if (r.code !== 0) return null;
    const [inside, prefix = ""] = r.out.split(/\r?\n/);
    return inside === "true" ? prefix : null;
  } catch {
    return null;
  }
}

/**
 * Which of `rels` (paths under `cwd`, `/`-separated) .gitignore leaves out.
 * A path git cannot take (one beyond a symbolic link) fails its whole
 * chunk, so the caller sends links without a trailing slash.
 */
export async function gitIgnored(git: Git, cwd: string, rels: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < rels.length; i += 200) {
    const chunk = rels.slice(i, i + 200);
    try {
      const r = await git(cwd, ["check-ignore", "--stdin", "-z"], chunk.join("\0") + "\0");
      if (r.code !== 0 && r.code !== 1) continue;
      for (const p of r.out.split("\0")) if (p) out.add(p.replace(/\\/g, "/").replace(/\/$/, ""));
    } catch {
      return out;
    }
  }
  return out;
}

/** The two-letter XY of `git status --porcelain` as one mark. */
export function markFor(xy: string): GitMark | null {
  if (xy === "??") return "U";
  const [x, y] = [xy[0] ?? " ", xy[1] ?? " "];
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "C";
  if (x === "R" || x === "C") return "R";
  if (x === "D" || y === "D") return "D";
  if (x === "A") return "A";
  if (x === "M" || y === "M" || x === "T" || y === "T") return "M";
  return null;
}

/**
 * `git status --porcelain=v1 -z` output as {path: mark}, the paths made
 * relative to the folder (porcelain paths start at the checkout's top, so
 * `prefix` is cut off; others are dropped).
 */
export function parseStatus(out: string, prefix: string): Map<string, GitMark> {
  const marks = new Map<string, GitMark>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    // A rename or copy is followed by its old path in a field of its own.
    if (xy[0] === "R" || xy[0] === "C") i++;
    const mark = markFor(xy);
    if (!mark || (prefix && !path.startsWith(prefix))) continue;
    marks.set(path.slice(prefix.length).replace(/\/$/, ""), mark);
  }
  return marks;
}

/** The changed files in `under` (a folder relative to `cwd`, `.` for all of it), by path relative to `cwd`; empty when git cannot say. */
export async function gitStatus(git: Git, cwd: string, prefix: string, under = "."): Promise<Map<string, GitMark>> {
  try {
    const r = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", under]);
    return r.code === 0 ? parseStatus(r.out, prefix) : new Map();
  } catch {
    return new Map();
  }
}
