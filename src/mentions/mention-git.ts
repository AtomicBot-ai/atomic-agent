/**
 * `@diff`, `@git:N` and the `@folder/` listing, read with git (ATO-2241,
 * shared since ATO-2472). execFile with fixed arguments (no shell; N is a
 * checked integer), a time limit and an output cap. `--relative -- .`
 * keeps diff and log to the working folder: when it is inside a bigger
 * checkout, changes and commits elsewhere in it are not read.
 *
 * The folder's own `.git/config` can name programs git runs. Every call
 * starts with gitSafePrefix(), the list the desktop hardened in ATO-2532
 * (desktop/main/git-safe-args.ts) so nothing is lost now that the desktop
 * reads mentions through core:
 *  - `--no-pager`: git never starts `core.pager`;
 *  - `--no-optional-locks`: a read does not rewrite the index (and so
 *    fires no `post-index-change` hook);
 *  - `core.fsmonitor=false`, `core.untrackedCache=false`;
 *  - `core.hooksPath=<null>`: `/dev/null`, or `NUL` on Windows, so no hook
 *    is found;
 *  - `log.showSignature=false`: `git log` never runs `gpg.program`;
 *  - `protocol.ext.allow=never`: no `ext::` remote helper command.
 * `--no-ext-diff --no-textconv` stop the configured external diff and
 * textconv programs. The environment is the command environment of the
 * shell tool (no provider keys) without an inherited GIT_DIR.
 */

import { execFile } from "node:child_process";

import { buildCommandEnv } from "../sandbox/command-env.js";

export const GIT_TIMEOUT_MS = 5_000;
/** Most output kept from git before the message's own caps apply. */
export const GIT_MAX_OUTPUT = 1024 * 1024;

/** The "no folder" path for `core.hooksPath` on this platform. */
export function gitNullPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "NUL" : "/dev/null";
}

/** Global options in front of every git call made here (they go before the subcommand). */
export function gitSafePrefix(platform: NodeJS.Platform = process.platform): string[] {
  return [
    "--no-pager",
    "--no-optional-locks",
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-c", `core.hooksPath=${gitNullPath(platform)}`,
    "-c", "log.showSignature=false",
    "-c", "protocol.ext.allow=never",
  ];
}

/** gitSafePrefix() for this platform. */
export const GIT_SAFE_PREFIX: readonly string[] = gitSafePrefix();

export interface GitOutput {
  text: string;
  /** git wrote more than the output cap. */
  cut: boolean;
}

/** Runs git with `args` (the subcommand on); GIT_SAFE_PREFIX is put in front. */
export type RunGit = (cwd: string, args: readonly string[]) => Promise<GitOutput>;

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--relative"];

/** `git diff HEAD`: staged and unstaged changes to tracked files under the folder. */
export function diffArgs(): string[] {
  return ["diff", "HEAD", ...DIFF_FLAGS, "--", "."];
}

/** `git diff HEAD --name-only`: the changed tracked files under the folder, relative to it. */
export function changedFilesArgs(): string[] {
  return ["diff", "HEAD", "--name-only", "-z", ...DIFF_FLAGS, "--", "."];
}

/** `git log -n<count> --stat -p` for the commits that touch the folder. */
export function logArgs(count: number): string[] {
  const n = Math.max(1, Math.floor(count));
  return ["log", `-n${n}`, "--date=iso", "--stat", "-p", ...DIFF_FLAGS, "--", "."];
}

/** `git ls-files`: tracked plus untracked files under the folder, minus .gitignore. */
export function lsFilesArgs(): string[] {
  return ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
}

export type ExecFileLike = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number; windowsHide: boolean; encoding: "utf8"; env: NodeJS.ProcessEnv },
  callback: (error: Error | null, stdout: string) => void,
) => unknown;

/** The environment git gets: no provider keys, no inherited GIT_DIR and friends pointing it elsewhere. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = buildCommandEnv(base);
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
  return env;
}

export function createRunGit(
  exec: ExecFileLike = execFile as unknown as ExecFileLike,
  limits: { timeoutMs: number; maxOutput: number } = { timeoutMs: GIT_TIMEOUT_MS, maxOutput: GIT_MAX_OUTPUT },
): RunGit {
  return (cwd, args) =>
    new Promise((done, fail) => {
      exec(
        "git",
        [...GIT_SAFE_PREFIX, ...args],
        { cwd, timeout: limits.timeoutMs, maxBuffer: limits.maxOutput, windowsHide: true, encoding: "utf8", env: gitEnv() },
        (error, stdout) => {
          const code = (error as { code?: unknown } | null)?.code;
          // Past the cap Node stops git and hands over what it had: keep that.
          if (error && code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return done({ text: String(stdout), cut: true });
          if (error) return fail(error);
          done({ text: String(stdout), cut: false });
        },
      );
    });
}

export const runGit: RunGit = createRunGit();
