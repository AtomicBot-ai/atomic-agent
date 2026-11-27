/**
 * ATO-2241: `@diff` and `@git:N`, read with git. execFile with fixed
 * arguments (no shell; N is a checked integer), a time limit and an output
 * cap. `--relative -- .` keeps both to the chat folder: when the folder is
 * inside a bigger checkout, changes and commits elsewhere in it are not read.
 * `--no-ext-diff --no-textconv` keep git from running configured helpers.
 */

import { execFile } from "node:child_process";

export const GIT_TIMEOUT_MS = 5_000;
/** Most output kept from git before the message's own caps apply. */
export const GIT_MAX_OUTPUT = 1024 * 1024;

export interface GitOutput {
  text: string;
  /** git wrote more than GIT_MAX_OUTPUT. */
  cut: boolean;
}

export type RunGit = (cwd: string, args: readonly string[]) => Promise<GitOutput>;

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--relative"];

/** `git diff HEAD`: staged and unstaged changes to tracked files under the folder. */
export function diffArgs(): string[] {
  return ["diff", "HEAD", ...DIFF_FLAGS, "--", "."];
}

/** `git log -n<count> --stat -p` for the commits that touch the folder. */
export function logArgs(count: number): string[] {
  const n = Math.max(1, Math.floor(count));
  return ["log", `-n${n}`, "--date=iso", "--stat", "-p", ...DIFF_FLAGS, "--", "."];
}

export const runGit: RunGit = (cwd, args) =>
  new Promise((done, fail) => {
    execFile(
      "git",
      [...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code;
        // Past the cap Node stops git and hands over what it had: keep that.
        if (error && code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return done({ text: String(stdout), cut: true });
        if (error) return fail(error);
        done({ text: String(stdout), cut: false });
      },
    );
  });
