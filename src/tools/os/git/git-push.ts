import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import {
  gitFailureResult,
  optionalString,
  refuseWhenRemoteSyncOff,
  requireGitRemoteApproval,
  runGitRemote,
  type GitRemoteToolOptions,
} from "./git-remote-policy.js";
import { requireGitSuccess, runGit } from "./git-runner.js";

const TOOL = "os.git.push";
const NETWORK_TIMEOUT_MS = 120_000;

/**
 * Publish the current (or a named) branch. No force flag exists here on
 * purpose — rewriting a remote is a shell job where the guard flags it
 * — and the first push of a branch sets its upstream so the next pull
 * knows where to go.
 */
export function buildOsGitPushTool(
  options: GitRemoteToolOptions,
): ToolDefinition {
  return {
    name: TOOL,
    description:
      "Push a branch (default: the current one) to a remote (default: origin). Sets the upstream on a branch's first push. Never forces. Needs Remote sync on; asks for approval — this is the moment a repository leaves the machine.",
    readonly: false,
    async run(rawArgs, ctx) {
      const repo = optionalString(rawArgs.repo);
      const remote = optionalString(rawArgs.remote) ?? "origin";
      const refused = refuseWhenRemoteSyncOff(TOOL, options, { remote });
      if (refused) return refused;

      const root = await runGit({
        repo,
        workingDir: ctx.workingDir,
        args: ["rev-parse", "--show-toplevel"],
        signal: ctx.signal,
        timeoutMs: 5_000,
      });
      requireGitSuccess(TOOL, root);
      const repoRoot = root.stdout.trim();

      let branch = optionalString(rawArgs.branch);
      if (!branch) {
        const head = await runGit({
          repo,
          workingDir: ctx.workingDir,
          args: ["symbolic-ref", "--short", "-q", "HEAD"],
          signal: ctx.signal,
          timeoutMs: 5_000,
        });
        branch = head.stdout.trim();
        if (!branch) {
          return compressToolResult({
            tool: TOOL,
            status: "error",
            output: `${TOOL}: HEAD is detached or unborn — pass \`branch\` or check out a branch first`,
            details: { remote, repoRoot },
          });
        }
      }
      const upstream = await runGit({
        repo,
        workingDir: ctx.workingDir,
        args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`],
        signal: ctx.signal,
        timeoutMs: 5_000,
      });
      const setUpstream = upstream.exitCode !== 0;
      const args = ["push"];
      if (setUpstream) args.push("--set-upstream");
      args.push(remote, branch);
      const preview = `git ${args.join(" ")}`;
      await requireGitRemoteApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: TOOL,
          reason: `push ${branch} to ${remote} from ${repoRoot}`,
          preview,
          affectedResources: [repoRoot],
        },
        ctx.signal,
      );
      const result = await runGitRemote(options, {
        repo,
        workingDir: ctx.workingDir,
        args,
        signal: ctx.signal,
        timeoutMs: NETWORK_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        return gitFailureResult(TOOL, result, { remote, branch, repoRoot });
      }
      const report = result.stderr.trim() || "(everything up to date)";
      return compressToolResult({
        tool: TOOL,
        status: "ok",
        output: `${preview}\n${report}`,
        details: { remote, branch, setUpstream, repoRoot },
      });
    },
  };
}
