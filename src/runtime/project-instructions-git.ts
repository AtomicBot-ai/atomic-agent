import { spawnSync } from "node:child_process";

/** What one git invocation returned; `runGit` test seams produce the same shape. */
export interface GitResult { status: number | null; stdout?: string; stderr?: string; error?: Error }

/** Runs git in the workspace with a cleaned environment and bounded output. */
export function runGitInWorkspace(root: string, args: string[], input?: string): GitResult {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
  return spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
    { cwd: root, env, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true, ...(input !== undefined ? { input } : {}) });
}

export function gitUnavailable(result: GitResult): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || /not a git repository/i.test(result.stderr ?? "");
}

export function gitFailure(result: GitResult): string {
  return (result.error?.message ?? result.stderr ?? "").trim().split("\n")[0] ?? "";
}
