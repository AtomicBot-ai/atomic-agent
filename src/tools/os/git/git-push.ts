import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import {
  refuseWhenRemoteSyncOff,
  requireGitRemoteApproval,
  type GitRemoteToolOptions,
} from "./git-remote-policy.js";
import {
  githubAuthGitEnv,
  isGithubHttpsRemote,
  resolveGithubToken,
  scrubGithubToken,
} from "../../../github/index.js";
import { requireBranchName } from "./git-checkout.js";
import { requireGitSuccess, runGit } from "./git-runner.js";

export interface OsGitPushOptions extends GitRemoteToolOptions {
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
      "Push a branch to a remote. Args: `remote` (default origin), `branch` (default: current branch), `setUpstream` (default true — `-u` so later pushes need no args), `repo` (optional path). Uses the GitHub token from the Integrations tab for github.com remotes. Needs Remote sync on (Integrations \u2192 GitHub). No force-push. Asks for approval \u2014 this is the moment a repository leaves the machine.",
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
      // `-u` is for a branch's *first* push. Asking for it again on a
      // branch that already tracks one is noise in the preview and a
      // second write to .git/config for no gain, so the flag is
      // dropped once an upstream exists — the operator's explicit
      // `setUpstream: false` still wins.
      const setUpstream =
        rawArgs.setUpstream !== false &&
        !(await hasUpstream(repo, ctx, branch));

      // The closed-repository check comes before the remote is even
      // resolved and before any prompt: with the switch off nothing
      // about this repository — not its remote URL, not a branch name —
      // needs to travel anywhere.
      const refused = refuseWhenRemoteSyncOff(
        "os.git.push",
        // An embedder or a test that never injected the predicate reads
        // as "nobody said this repository may leave" — closed.
        { ...options, isRemoteSyncEnabled: options.isRemoteSyncEnabled ?? (() => false) },
        { remote, branch },
      );
      if (refused) return refused;

      const remoteUrl = await readRemoteUrl(repo, ctx, remote);
      const invocation = buildPushInvocation({
        remote,
        branch,
        setUpstream,
        remoteUrl,
        token: resolveToken(),
      });
      // `git_remote`, not `shell`: this is the moment a repository
      // leaves the machine, and a session grant answered on an
      // unrelated shell prompt must not be able to silence it.
      await requireGitRemoteApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: "os.git.push",
          reason: `push ${branch} to ${remote}`,
          preview: `git ${invocation.args.join(" ")}\nremote: ${remoteUrl}${invocation.authenticated ? "\nauth: GitHub token from the Integrations tab" : ""}`,
          affectedResources: [remoteUrl],
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

async function hasUpstream(
  repo: string | undefined,
  ctx: { workingDir: string; signal: AbortSignal },
  branch: string,
): Promise<boolean> {
  const res = await runGit({
    repo,
    workingDir: ctx.workingDir,
    args: ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`],
    signal: ctx.signal,
    timeoutMs: 5_000,
  });
  return res.exitCode === 0 && res.stdout.trim().length > 0;
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
