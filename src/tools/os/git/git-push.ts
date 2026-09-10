import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../../approval/dangerous-tool.js";
import {
  githubAuthGitEnv,
  isGithubHttpsRemote,
  resolveGithubToken,
  scrubGithubToken,
} from "../../../github/index.js";
import { requireBranchName } from "./git-checkout.js";
import { requireGitSuccess, runGit } from "./git-runner.js";

export interface OsGitPushOptions extends DangerousToolOptions {
  /** Test seam; production reads `GITHUB_TOKEN` at call time. */
  resolveToken?: () => string | null;
}

/**
 * Push the current (or a named) branch.
 *
 * When the remote is on github.com and the Integrations hub holds a
 * token, the token rides along as a per-invocation HTTP header (see
 * `git-auth-header.ts`) — never written to any config, never attached
 * to a non-GitHub host. Without a token the push runs exactly as the
 * operator's own git would (SSH keys, credential helpers), so an
 * unconnected hub is not a broken push, just an unassisted one.
 *
 * `force` is deliberately not an argument. A force-push rewrites
 * history other people may have; if the operator wants one they can
 * ask for the shell command and approve it with their eyes open.
 */
export function buildOsGitPushTool(options: OsGitPushOptions): ToolDefinition {
  const resolveToken = options.resolveToken ?? (() => resolveGithubToken());
  return {
    name: "os.git.push",
    description:
      "Push a branch to a remote. Args: `remote` (default origin), `branch` (default: current branch), `setUpstream` (default true — `-u` so later pushes need no args), `repo` (optional path). Uses the GitHub token from the Integrations tab for github.com remotes. No force-push. May require approval.",
    readonly: false,
    async run(rawArgs, ctx) {
      const repo = typeof rawArgs.repo === "string" ? rawArgs.repo : undefined;
      const remote =
        typeof rawArgs.remote === "string" && rawArgs.remote.trim()
          ? requireBranchName(rawArgs.remote, "os.git.push")
          : "origin";
      const branch =
        rawArgs.branch === undefined || rawArgs.branch === null
          ? await currentBranch(repo, ctx)
          : requireBranchName(rawArgs.branch, "os.git.push");
      const setUpstream = rawArgs.setUpstream !== false;

      const remoteUrl = await readRemoteUrl(repo, ctx, remote);
      const invocation = buildPushInvocation({
        remote,
        branch,
        setUpstream,
        remoteUrl,
        token: resolveToken(),
      });
      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: "os.git.push",
          category: "shell",
          reason: `push ${branch} to ${remote}`,
          preview: `git ${invocation.args.join(" ")}\nremote: ${remoteUrl}${invocation.authenticated ? "\nauth: GitHub token from the Integrations tab" : ""}`,
        },
        ctx.signal,
      );

      const result = await runGit({
        repo,
        workingDir: ctx.workingDir,
        args: invocation.args,
        env: invocation.env,
        signal: ctx.signal,
        timeoutMs: 120_000,
      });
      if (result.exitCode !== 0) {
        // Git echoes the remote and sometimes the header on failure;
        // scrub before the text reaches the model or the trace.
        throw new Error(
          scrubGithubToken(
            `os.git.push: git push exited with ${result.exitCode}: ${result.stderr.trim() || "(no stderr)"}`,
          ),
        );
      }
      requireGitSuccess("os.git.push", result);
      // Git reports the push on stderr; keep the lines that matter.
      const output = scrubGithubToken(
        result.stderr
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0 && !/^remote:\s*$/.test(l))
          .join("\n") || `pushed ${branch} to ${remote}`,
      );
      return compressToolResult({
        tool: "os.git.push",
        status: "ok",
        output,
        details: {
          remote,
          branch,
          setUpstream,
          authenticated: invocation.authenticated,
          remoteUrl,
          repoRoot: result.repoRoot,
        },
      });
    },
  };
}

export interface PushInvocation {
  /** `push [-u] <remote> <branch>:<branch>` — never carries the token. */
  args: string[];
  /** Extra env for the git process; the token rides here, if at all. */
  env: NodeJS.ProcessEnv;
  authenticated: boolean;
}

/**
 * The exact git invocation a push runs, as data. The token is attached
 * only for an `https://github.com/` remote, and only through the env
 * (`GIT_CONFIG_*`), never through argv — pinned by the tests.
 */
export function buildPushInvocation(input: {
  remote: string;
  branch: string;
  setUpstream: boolean;
  remoteUrl: string;
  token: string | null;
}): PushInvocation {
  const args = [
    "push",
    ...(input.setUpstream ? ["-u"] : []),
    input.remote,
    `${input.branch}:${input.branch}`,
  ];
  const useToken = input.token !== null && isGithubHttpsRemote(input.remoteUrl);
  return {
    args,
    env: useToken ? githubAuthGitEnv(input.token!) : {},
    authenticated: useToken,
  };
}

async function currentBranch(
  repo: string | undefined,
  ctx: { workingDir: string; signal: AbortSignal },
): Promise<string> {
  const res = await runGit({
    repo,
    workingDir: ctx.workingDir,
    args: ["symbolic-ref", "--short", "-q", "HEAD"],
    signal: ctx.signal,
    timeoutMs: 5_000,
  });
  const branch = res.stdout.trim();
  if (res.exitCode !== 0 || branch.length === 0) {
    throw new Error(
      "os.git.push: HEAD is detached — pass `branch` explicitly or check out a branch first",
    );
  }
  return branch;
}

async function readRemoteUrl(
  repo: string | undefined,
  ctx: { workingDir: string; signal: AbortSignal },
  remote: string,
): Promise<string> {
  const res = await runGit({
    repo,
    workingDir: ctx.workingDir,
    args: ["remote", "get-url", "--push", remote],
    signal: ctx.signal,
    timeoutMs: 5_000,
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `os.git.push: remote ${JSON.stringify(remote)} is not configured: ${res.stderr.trim()}`,
    );
  }
  return res.stdout.trim();
}
