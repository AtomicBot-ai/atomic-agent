import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand } from "../../../sandbox/command-runner.js";
import type { ToolContext } from "../../tool-registry.js";

export async function makeGitRepo(prefix = "atomic-git-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await runGitInit(dir);
  return dir;
}

async function runGitInit(dir: string): Promise<void> {
  // A minimal, deterministic repo: disable hooks/signing, set identity so
  // commits succeed even on machines where git is unconfigured.
  await runGitRaw(dir, ["init", "--initial-branch=main", "-q"]);
  await runGitRaw(dir, ["config", "user.name", "Magos Test"]);
  await runGitRaw(dir, ["config", "user.email", "magos@omnissiah.test"]);
  await runGitRaw(dir, ["config", "commit.gpgsign", "false"]);
  await runGitRaw(dir, ["config", "tag.gpgsign", "false"]);
}

export async function runGitRaw(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const res = await runCommand("git", args, {
    cwd,
    timeoutMs: 10_000,
    env: {
      ...process.env,
      GIT_PAGER: "",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z",
    },
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`,
    );
  }
  return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
}

export async function writeRepoFile(
  repo: string,
  relPath: string,
  content: string,
): Promise<void> {
  const full = join(repo, relPath);
  const parent = dirname(full);
  if (parent && parent !== repo) await mkdir(parent, { recursive: true });
  await writeFile(full, content, "utf8");
}

export function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}
