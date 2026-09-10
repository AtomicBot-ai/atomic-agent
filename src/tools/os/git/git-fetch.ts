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

const TOOL = "os.git.fetch";
const NETWORK_TIMEOUT_MS = 120_000;

/** Bring remote refs up to date without touching the working tree. */
export function buildOsGitFetchTool(
  options: GitRemoteToolOptions,
): ToolDefinition {
  return {
    name: TOOL,
    description:
      "Fetch from a remote (default: origin; `all: true` for every remote). `prune` drops deleted remote branches. Needs Remote sync on; asks for approval. Does not change the working tree.",
    readonly: false,
    async run(rawArgs, ctx) {
      const repo = optionalString(rawArgs.repo);
      const remote = optionalString(rawArgs.remote) ?? "origin";
      const all = rawArgs.all === true;
      const prune = rawArgs.prune === true;
      const refused = refuseWhenRemoteSyncOff(TOOL, options, { remote, all });
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
      const args = ["fetch"];
      if (prune) args.push("--prune");
      if (all) args.push("--all");
      else args.push(remote);
      const preview = `git ${args.join(" ")}`;
      await requireGitRemoteApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: TOOL,
          reason: `fetch ${all ? "all remotes" : remote} in ${repoRoot}`,
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
        return gitFailureResult(TOOL, result, { remote, all, prune, repoRoot });
      }
      const report = result.stderr.trim() || "(already up to date)";
      return compressToolResult({
        tool: TOOL,
        status: "ok",
        output: `${preview}\n${report}`,
        details: { remote: all ? null : remote, all, prune, repoRoot },
      });
    },
  };
}
