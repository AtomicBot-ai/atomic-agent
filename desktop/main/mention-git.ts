/**
 * ATO-2241: `@diff`, `@git:N` and the `@folder/` listing, read with git.
 * execFile with fixed arguments (no shell; N is a checked integer), a time
 * limit and an output cap. `--relative -- .` keeps diff and log to the chat
 * folder: when the folder is inside a bigger checkout, changes and commits
 * elsewhere in it are not read.
 *
 * The folder's own `.git/config` can name programs git runs. Every call
 * starts with GIT_SAFE_PREFIX, the shared desktop list (git-safe-args.ts,
 * ATO-2532: no fsmonitor, no hooks, no pager, no signature check, no
 * index write). `--no-ext-diff --no-textconv` stop the configured
 * external diff and textconv programs, `--submodule=short` keeps a
 * changed submodule from starting its own diff, `--ignore-submodules=dirty`
 * keeps git from starting a status (and its clean filters) inside each
 * submodule, and log's explicit
 * `--pretty=medium` keeps a configured `format.pretty` from asking for a
 * signature check.
 */

import { execFile } from "node:child_process";

import { gitSafeArgs } from "./git-safe-args.js";

export const GIT_TIMEOUT_MS = 5_000;
/** Most output kept from git before the message's own caps apply. */
export const GIT_MAX_OUTPUT = 1024 * 1024;

/** Global options in front of every git call made here. */
export const GIT_SAFE_PREFIX: readonly string[] = gitSafeArgs();

export interface GitOutput {
  text: string;
  /** git wrote more than GIT_MAX_OUTPUT. */
  cut: boolean;
}

/** Runs git with `args` (the subcommand on); GIT_SAFE_PREFIX is put in front. */
export type RunGit = (cwd: string, args: readonly string[]) => Promise<GitOutput>;

/**
 * `--submodule=short` (review round 2, R2-1979.A): with a repo's
 * `diff.submodule=diff`, git starts a second `git diff` inside each
 * changed submodule. The `-c` options reach that child through
 * GIT_CONFIG_PARAMETERS, but `--no-ext-diff` and `--no-textconv` do not,
 * so the submodule's own `diff.external` would run. `short` prints only
 * the two commit ids and starts no child diff. The safe prefix also sets
 * `diff.submodule=short`; the flag here wins over any config.
 *
 * `--ignore-submodules=dirty` (review round 3, F1979-R3.1): to tell
 * whether a submodule's work tree is dirty, `git diff HEAD` starts a
 * child `git status` inside it. That child applies the submodule's own
 * clean filters (`filter.<name>.clean` in `.git/modules/<sub>/config`
 * with a matching attribute) to every stat-dirty file, so the
 * submodule's program would run. With `dirty`, git compares only the
 * submodule's checked-out commit (read from its HEAD, no child process)
 * and still shows a moved submodule. The flag also wins over
 * `diff.ignoreSubmodules` and `submodule.<name>.ignore`. The parent
 * repo's own clean filters are ATO-2785.
 */
const DIFF_FLAGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--submodule=short",
  "--ignore-submodules=dirty",
  "--relative",
];

/** `git diff HEAD`: staged and unstaged changes to tracked files under the folder. */
export function diffArgs(): string[] {
  return ["diff", "HEAD", ...DIFF_FLAGS, "--", "."];
}

/**
 * `git log -n<count> --stat -p` for the commits that touch the folder.
 * `--pretty=medium` is explicit: a repo's `format.pretty` with `%G?`
 * would make git verify a signed commit with the repo's `gpg.program`,
 * which `log.showSignature=false` does not cover.
 */
export function logArgs(count: number): string[] {
  const n = Math.max(1, Math.floor(count));
  return ["log", `-n${n}`, "--date=iso", "--pretty=medium", "--stat", "-p", ...DIFF_FLAGS, "--", "."];
}

/** `git ls-files`: tracked plus untracked files under the folder, minus .gitignore. */
export function lsFilesArgs(): string[] {
  return ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
}

type ExecFileLike = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number; windowsHide: boolean; encoding: "utf8"; env: NodeJS.ProcessEnv },
  callback: (error: Error | null, stdout: string) => void,
) => unknown;

/** The environment git gets: no inherited GIT_DIR and friends pointing it elsewhere. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
  return env;
}

export function createRunGit(exec: ExecFileLike = execFile as unknown as ExecFileLike): RunGit {
  return (cwd, args) =>
    new Promise((done, fail) => {
      exec(
        "git",
        [...GIT_SAFE_PREFIX, ...args],
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT, windowsHide: true, encoding: "utf8", env: gitEnv() },
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
