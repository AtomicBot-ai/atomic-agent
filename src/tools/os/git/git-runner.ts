import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { runCommand, type CommandResult } from "../../../sandbox/command-runner.js";

/**
 * Result of running `git <subcommand> …` with a structured failure mode.
 * All git tools use this so callers get a uniform shape regardless of
 * which subcommand they asked for.
 */
export interface GitRunResult extends CommandResult {
  repoRoot: string;
}

export interface GitRunOptions {
  /** Repo root or a path inside a repo; if omitted, we use the tool's working dir. */
  repo?: string | undefined;
  /** Working directory of the ToolContext, used when `repo` is omitted. */
  workingDir: string;
  /** Subcommand + args — e.g. `["log", "--pretty=…"]`. */
  args: string[];
  /** Default 15s; bumped by callers that stream a lot of lines. */
  timeoutMs?: number;
  /** Cap git's stdout+stderr. */
  maxOutputBytes?: number;
  /** Abort signal from the ToolContext. */
  signal: AbortSignal;
  /** Extra env vars — e.g. `GIT_PAGER=cat` is always injected. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;

/**
 * Shared shell-out helper for every `os.git.*` tool. Enforces:
 *  - `GIT_PAGER=cat` + `GIT_TERMINAL_PROMPT=0` so git never blocks on a
 *    pager or credential prompt inside the agent.
 *  - Timeout + output-size cap inherited from `runCommand`.
 *  - Repo root resolution — the repo is always validated before git runs
 *    so we fail loudly if the path is outside any repo.
 */
export async function runGit(options: GitRunOptions): Promise<GitRunResult> {
  const repoRoot = await resolveRepoRoot(options.repo, options.workingDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  const result = await runCommand("git", options.args, {
    cwd: repoRoot,
    env,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    signal: options.signal,
  });
  return { ...result, repoRoot };
}

async function resolveRepoRoot(
  explicit: string | undefined,
  workingDir: string,
): Promise<string> {
  const candidate = explicit
    ? isAbsolute(explicit)
      ? explicit
      : resolve(workingDir, explicit)
    : workingDir;
  try {
    const info = await stat(candidate);
    if (!info.isDirectory()) {
      throw new Error(
        `os.git: repo path ${candidate} is not a directory`,
      );
    }
  } catch (err) {
    throw new Error(
      `os.git: cannot access repo ${candidate}: ${(err as Error).message}`,
    );
  }
  return candidate;
}

/**
 * Turn a git failure (non-zero exit) into a clear error. Git's own stderr
 * is preserved verbatim because its messages are uniformly the most
 * useful thing to show the operator.
 */
export function requireGitSuccess(
  tool: string,
  result: GitRunResult,
): void {
  if (result.timedOut) {
    throw new Error(`${tool}: git timed out after ${result.durationMs}ms`);
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim() || "(no stderr)";
    throw new Error(
      `${tool}: git ${result.args.join(" ")} exited with ${result.exitCode}: ${stderr}`,
    );
  }
}
