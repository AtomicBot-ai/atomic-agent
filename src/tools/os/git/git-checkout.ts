import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import type { FsDangerousToolOptions } from "../fs-require-approval.js";
import { buildGitErrorResult, describeGitFailure } from "./git-error-result.js";
import {
  formatGitCommandLine,
  requireGitMutationApproval,
} from "./git-mutation-approval.js";
import { describeHead, resolveGitToplevel } from "./git-repo-probe.js";
import { runGit } from "./git-runner.js";

const TOOL = "os.git.checkout";

interface CheckoutArgs {
  repo?: string;
  branch: string;
  create: boolean;
  startPoint?: string;
}

/**
 * `os.git.checkout` — switch branches. Runs `git switch`, not
 * `git checkout`, so an argument can only ever name a branch: a path
 * can never be mistaken for one and silently discard working-tree edits.
 * A dirty tree that would be overwritten is git's call — its refusal
 * comes back verbatim as a structured error.
 */
export function buildOsGitCheckoutTool(
  options: FsDangerousToolOptions,
): ToolDefinition {
  return {
    name: TOOL,
    description:
      "Switch to `branch` (`git switch`); `create: true` creates it first (`git switch -c <branch> [startPoint]`). Branches only, never paths. Requires approval like a file write in the repository.",
    readonly: false,
    async run(rawArgs, ctx) {
      const parsed = parseArgs(rawArgs);
      if (!parsed.ok) return buildGitErrorResult(TOOL, parsed.message);
      const args = parsed.value;
      const probe = { repo: args.repo, workingDir: ctx.workingDir, signal: ctx.signal };

      const toplevel = await resolveGitToplevel(probe);
      if (!toplevel.ok) return buildGitErrorResult(TOOL, `${TOOL}: ${toplevel.message}`);
      const before = await describeHead(probe);

      const gitArgs = args.create
        ? ["switch", "-c", args.branch, ...(args.startPoint ? [args.startPoint] : [])]
        : ["switch", args.branch];

      await requireGitMutationApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: TOOL,
          repoRoot: toplevel.root,
          reason: `git switch in ${toplevel.root}`,
          preview: formatGitCommandLine(gitArgs),
          workingDir: ctx.workingDir,
          trustConfigPaths: options.trustConfigPaths,
        },
        ctx.signal,
      );

      const result = await runGit({ ...probe, args: gitArgs });
      if (result.exitCode !== 0) {
        return buildGitErrorResult(TOOL, describeGitFailure(result), {
          repoRoot: toplevel.root,
          branch: args.branch,
          create: args.create,
        });
      }

      const after = await describeHead(probe);
      const from = before.branch ?? "(detached)";
      const at = after.shortHash ? ` at ${after.shortHash}` : "";
      const origin = args.startPoint ? ` from ${args.startPoint}` : "";
      return compressToolResult({
        tool: TOOL,
        status: "ok",
        output: args.create
          ? `created and switched to branch '${args.branch}'${origin}${at} (was on ${from})`
          : `switched to branch '${args.branch}'${at} (was on ${from})`,
        details: {
          repoRoot: toplevel.root,
          branch: after.branch ?? args.branch,
          created: args.create,
          startPoint: args.startPoint ?? null,
          previousBranch: before.branch,
          hash: after.hash,
          shortHash: after.shortHash,
        },
      });
    },
  };
}

function parseArgs(
  rawArgs: Record<string, unknown>,
): { ok: true; value: CheckoutArgs } | { ok: false; message: string } {
  const branch = typeof rawArgs.branch === "string" ? rawArgs.branch.trim() : "";
  if (branch.length === 0) {
    return { ok: false, message: `${TOOL}: \`branch\` is required` };
  }
  if (branch.startsWith("-")) {
    return { ok: false, message: `${TOOL}: \`branch\` may not start with "-"` };
  }
  const create = rawArgs.create === true;
  const startPointRaw = rawArgs.startPoint;
  let startPoint: string | undefined;
  if (startPointRaw !== undefined && startPointRaw !== null) {
    startPoint = typeof startPointRaw === "string" ? startPointRaw.trim() : "";
    if (startPoint.length === 0 || startPoint.startsWith("-")) {
      return {
        ok: false,
        message: `${TOOL}: \`startPoint\` must be a commit-ish that does not start with "-"`,
      };
    }
    if (!create) {
      return {
        ok: false,
        message: `${TOOL}: \`startPoint\` only applies with \`create: true\``,
      };
    }
  }
  const repo = typeof rawArgs.repo === "string" && rawArgs.repo.length > 0
    ? rawArgs.repo
    : undefined;
  const value: CheckoutArgs = { branch, create };
  if (repo !== undefined) value.repo = repo;
  if (startPoint !== undefined) value.startPoint = startPoint;
  return { ok: true, value };
}
