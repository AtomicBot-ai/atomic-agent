import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { requireGitSuccess, runGit } from "./git-runner.js";

export const osGitDiffTool: ToolDefinition = {
  name: "os.git.diff",
  description:
    "Show a unified diff. Args (all optional): revisionRange (e.g. 'HEAD~3..HEAD' or single 'HEAD~1'), staged (bool — --cached), paths (array of path filters), context (lines of context, default 3). Read-only.",
  readonly: true,
  async run(rawArgs, ctx) {
    const repo = typeof rawArgs.repo === "string" ? rawArgs.repo : undefined;
    const revisionRange =
      typeof rawArgs.revisionRange === "string" && rawArgs.revisionRange.length > 0
        ? rawArgs.revisionRange
        : undefined;
    const staged = rawArgs.staged === true;
    const context = parseContext(rawArgs.context, 3);
    const paths = parsePaths(rawArgs.paths);

    const args: string[] = ["diff", `--unified=${context}`];
    if (staged) args.push("--cached");
    if (revisionRange) args.push(revisionRange);
    if (paths.length > 0) {
      args.push("--");
      args.push(...paths);
    }

    const result = await runGit({
      repo,
      workingDir: ctx.workingDir,
      args,
      signal: ctx.signal,
      timeoutMs: 30_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });
    requireGitSuccess("os.git.diff", result);

    const stats = countAddRemove(result.stdout);
    const empty = result.stdout.trim().length === 0;

    return compressToolResult(
      {
        tool: "os.git.diff",
        status: "ok",
        output: empty ? "(no diff)" : result.stdout,
        details: {
          empty,
          added: stats.added,
          removed: stats.removed,
          truncated: result.truncated,
          repoRoot: result.repoRoot,
          revisionRange: revisionRange ?? null,
          staged,
          paths,
        },
      },
      { maxSummaryLength: 64 * 1024, maxTailLines: 4000 },
    );
  },
};

function parseContext(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new Error("os.git.diff: `context` must be a non-negative number");
  }
  return Math.floor(raw);
}

function parsePaths(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("os.git.diff: `paths` must be an array of strings");
  }
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== "string" || p.length === 0) {
      throw new Error("os.git.diff: `paths` entries must be non-empty strings");
    }
    out.push(p);
  }
  return out;
}

function countAddRemove(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}
