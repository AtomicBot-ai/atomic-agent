import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../../approval/dangerous-tool.js";
import { requireGitSuccess, runGit } from "./git-runner.js";

/**
 * Stage and commit in one call.
 *
 * `paths` stages exactly those paths; `all: true` stages every change
 * (`git add -A`); neither commits only what is already staged. The
 * approval preview shows the porcelain status of what is about to be
 * committed, because "commit" is meaningless to approve without
 * knowing which files ride along.
 *
 * Identity is git's own — the tool never passes `--author`, so a
 * commit made through the agent is authored by whoever the repo or
 * global config says, exactly as if the operator had typed it.
 */
export function buildOsGitCommitTool(
  options: DangerousToolOptions,
): ToolDefinition {
  return {
    name: "os.git.commit",
    description:
      "Stage and commit. Args: `message` (required), `paths` (stage these paths first), `all` (stage every change incl. untracked; default false), `repo` (optional path). With neither `paths` nor `all` only what is already staged is committed. May require approval.",
    readonly: false,
    async run(rawArgs, ctx) {
      const repo = typeof rawArgs.repo === "string" ? rawArgs.repo : undefined;
      const message = parseMessage(rawArgs.message);
      const paths = parsePaths(rawArgs.paths);
      const all = rawArgs.all === true;
      if (all && paths.length > 0) {
        throw new Error("os.git.commit: pass either `paths` or `all`, not both");
      }

      const preview = await describeStaging(repo, ctx, paths, all);
      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: "os.git.commit",
          category: "shell",
          reason: `commit "${firstLine(message)}"`,
          preview,
        },
        ctx.signal,
      );

      if (all) {
        const add = await runGit({
          repo,
          workingDir: ctx.workingDir,
          args: ["add", "-A"],
          signal: ctx.signal,
        });
        requireGitSuccess("os.git.commit", add);
      } else if (paths.length > 0) {
        const add = await runGit({
          repo,
          workingDir: ctx.workingDir,
          args: ["add", "--", ...paths],
          signal: ctx.signal,
        });
        requireGitSuccess("os.git.commit", add);
      }

      const commit = await runGit({
        repo,
        workingDir: ctx.workingDir,
        args: ["commit", "-m", message],
        signal: ctx.signal,
        timeoutMs: 30_000,
      });
      if (commit.exitCode !== 0 && /nothing to commit/i.test(commit.stdout + commit.stderr)) {
        throw new Error(
          "os.git.commit: nothing to commit — stage changes with `paths` or `all: true`",
        );
      }
      requireGitSuccess("os.git.commit", commit);

      const head = await runGit({
        repo,
        workingDir: ctx.workingDir,
        args: ["rev-parse", "--short", "HEAD"],
        signal: ctx.signal,
        timeoutMs: 5_000,
      });
      const hash = head.exitCode === 0 ? head.stdout.trim() : null;
      return compressToolResult({
        tool: "os.git.commit",
        status: "ok",
        output: commit.stdout.trim() || `committed ${hash ?? ""}`.trim(),
        details: {
          hash,
          message,
          stagedAll: all,
          paths,
          repoRoot: commit.repoRoot,
        },
      });
    },
  };
}

function parseMessage(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("os.git.commit: `message` must be a non-empty string");
  }
  return raw.trim();
}

function parsePaths(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((p) => typeof p === "string")) {
    throw new Error("os.git.commit: `paths` must be an array of strings");
  }
  const paths = (raw as string[]).map((p) => p.trim()).filter((p) => p.length > 0);
  for (const p of paths) {
    if (p.startsWith("-")) {
      throw new Error(`os.git.commit: path ${JSON.stringify(p)} must not start with '-'`);
    }
  }
  return paths;
}

function firstLine(message: string): string {
  const line = message.split(/\r?\n/, 1)[0] ?? message;
  return line.length > 72 ? `${line.slice(0, 69)}…` : line;
}

/**
 * The approval preview: what `git status --short` says about the
 * paths that are about to be staged and committed. Best-effort — a
 * failure here must not block the approval prompt, it just makes the
 * preview less informative.
 */
async function describeStaging(
  repo: string | undefined,
  ctx: { workingDir: string; signal: AbortSignal },
  paths: readonly string[],
  all: boolean,
): Promise<string> {
  try {
    const args = ["status", "--short"];
    if (!all && paths.length > 0) args.push("--", ...paths);
    const status = await runGit({
      repo,
      workingDir: ctx.workingDir,
      args,
      signal: ctx.signal,
      timeoutMs: 10_000,
    });
    if (status.exitCode !== 0) return "(could not read git status)";
    const lines = status.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const scope = all
      ? "staging every change"
      : paths.length > 0
        ? `staging ${paths.length} path${paths.length === 1 ? "" : "s"}`
        : "committing what is already staged";
    // Without `all` or `paths`, only the index matters: drop unstaged rows.
    const shown = all || paths.length > 0
      ? lines
      : lines.filter((l) => l[0] !== " " && l[0] !== "?");
    const head = shown.slice(0, 40);
    const more = shown.length > head.length ? `\n… ${shown.length - head.length} more` : "";
    return `${scope}\n${head.join("\n") || "(no changes)"}${more}`;
  } catch (err) {
    return `(could not read git status: ${(err as Error).message})`;
  }
}
