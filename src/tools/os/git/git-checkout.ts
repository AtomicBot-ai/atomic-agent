import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../../approval/dangerous-tool.js";
import { requireGitSuccess, runGit } from "./git-runner.js";

/**
 * Switch branches, optionally creating one first.
 *
 * A checkout rewrites the working tree, so it goes through the gate
 * like a shell command would — a model that "just switches to main"
 * on top of uncommitted work is exactly the kind of thing the
 * operator wants to see coming. Git itself refuses to discard local
 * changes (no `--force` is ever passed), so the worst case is a
 * refusal, never lost work.
 */
export function buildOsGitCheckoutTool(
  options: DangerousToolOptions,
): ToolDefinition {
  return {
    name: "os.git.checkout",
    description:
      "Switch to a branch, or create one and switch to it. Args: `branch` (required), `create` (default false — create the branch first), `startPoint` (commit-ish the new branch starts from; default HEAD), `repo` (optional path). May require approval.",
    readonly: false,
    async run(rawArgs, ctx) {
      const repo = typeof rawArgs.repo === "string" ? rawArgs.repo : undefined;
      const branch = requireBranchName(rawArgs.branch, "os.git.checkout");
      const create = rawArgs.create === true;
      const startPoint =
        typeof rawArgs.startPoint === "string" && rawArgs.startPoint.trim()
          ? requireRevision(rawArgs.startPoint, "os.git.checkout", "startPoint")
          : undefined;
      if (startPoint && !create) {
        throw new Error(
          "os.git.checkout: `startPoint` only makes sense with `create: true`",
        );
      }
      const args = create
        ? ["checkout", "-b", branch, ...(startPoint ? [startPoint] : [])]
        : ["checkout", branch];

      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: "os.git.checkout",
          category: "shell",
          reason: create
            ? `create branch ${branch}${startPoint ? ` from ${startPoint}` : ""} and switch to it`
            : `switch to branch ${branch}`,
          preview: `git ${args.join(" ")}`,
        },
        ctx.signal,
      );

      const result = await runGit({
        repo,
        workingDir: ctx.workingDir,
        args,
        signal: ctx.signal,
      });
      requireGitSuccess("os.git.checkout", result);
      const output = (result.stderr.trim() || result.stdout.trim()) ||
        `switched to ${branch}`;
      return compressToolResult({
        tool: "os.git.checkout",
        status: "ok",
        output,
        details: {
          branch,
          created: create,
          startPoint: startPoint ?? null,
          repoRoot: result.repoRoot,
        },
      });
    },
  };
}

/**
 * A branch name that could be mistaken for a flag (`-b`, `--orphan`)
 * would change what the command does; git's own ref rules reject the
 * rest. Checked here so the refusal names the tool, not a git usage
 * screen.
 */
export function requireBranchName(raw: unknown, tool: string): string {
  return requireRevision(raw, tool, "branch");
}

/**
 * Same rule for any commit-ish the model hands git as a positional:
 * git permutes options after positionals, so a `startPoint` of
 * `--force` would turn `checkout -b x --force` into a working-tree
 * reset. Rejected here, by name, before git sees it.
 */
export function requireRevision(raw: unknown, tool: string, field: string): string {
  const branch = checkRef(raw, tool, field);
  return branch;
}

function checkRef(raw: unknown, tool: string, field: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${tool}: \`${field}\` must be a non-empty string`);
  }
  const branch = raw.trim();
  if (branch.startsWith("-")) {
    throw new Error(`${tool}: \`${field}\` must not start with '-'`);
  }
  if (/\s/.test(branch)) {
    throw new Error(`${tool}: \`${field}\` must not contain whitespace`);
  }
  return branch;
}
