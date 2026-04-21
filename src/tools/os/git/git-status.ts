import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { requireGitSuccess, runGit } from "./git-runner.js";

/**
 * Each status entry corresponds to one path reported by
 * `git status --porcelain=v1 -z`. Codes are standard git:
 * ' ' = unmodified, M = modified, A = added, D = deleted, R = renamed,
 * C = copied, U = updated-but-unmerged, ? = untracked.
 */
export interface GitStatusEntry {
  path: string;
  indexStatus: string;
  workingStatus: string;
  renamedFrom?: string;
}

export const osGitStatusTool: ToolDefinition = {
  name: "os.git.status",
  description:
    "Show working-tree status (porcelain). Returns a structured list of changed/untracked paths plus the current branch. Read-only.",
  readonly: true,
  async run(rawArgs, ctx) {
    const repo = typeof rawArgs.repo === "string" ? rawArgs.repo : undefined;
    // --porcelain=v1 -z → stable machine-readable format; NUL-delimited so
    // paths with spaces or newlines parse unambiguously.
    const [statusResult, branchResult] = await Promise.all([
      runGit({
        repo,
        workingDir: ctx.workingDir,
        args: ["status", "--porcelain=v1", "-z", "--branch"],
        signal: ctx.signal,
      }),
      runGit({
        repo,
        workingDir: ctx.workingDir,
        // `symbolic-ref --short HEAD` works even on a repo without any
        // commits yet (detached vs not doesn't matter here — we just
        // want whatever HEAD currently points at, or "(detached)").
        args: ["symbolic-ref", "--short", "-q", "HEAD"],
        signal: ctx.signal,
        timeoutMs: 5_000,
      }),
    ]);
    requireGitSuccess("os.git.status", statusResult);
    // symbolic-ref returns non-zero on detached HEAD; that's expected,
    // so fall back to a short commit hash instead of throwing.
    const { entries, branchInfo } = parsePorcelain(statusResult.stdout);
    let branch = branchResult.stdout.trim();
    if (!branch) {
      const headHash = await runGit({
        repo,
        workingDir: ctx.workingDir,
        args: ["rev-parse", "--short", "HEAD"],
        signal: ctx.signal,
        timeoutMs: 5_000,
      });
      branch = headHash.exitCode === 0
        ? `(detached ${headHash.stdout.trim()})`
        : "(unborn)";
    }

    const human = formatHuman(branch, branchInfo, entries);
    return compressToolResult({
      tool: "os.git.status",
      status: "ok",
      output: human,
      details: {
        branch,
        branchInfo,
        entries,
        clean: entries.length === 0,
        repoRoot: statusResult.repoRoot,
      },
    });
  },
};

/**
 * Parse `git status --porcelain=v1 -z` output.
 *
 * Format:
 *   XY<SP><path>[<NUL><origPath>]<NUL>
 * where XY are two status codes (index + working tree). When the status
 * is `R` (rename) or `C` (copy), the ORIG path is emitted as a separate
 * NUL-delimited token right after the new path.
 *
 * The very first record may be `## <branch>...` pseudo-header when
 * `--branch` is passed — we extract that into branchInfo.
 */
function parsePorcelain(stdout: string): {
  entries: GitStatusEntry[];
  branchInfo: string | null;
} {
  if (!stdout) return { entries: [], branchInfo: null };
  const records = stdout.split("\0");
  const entries: GitStatusEntry[] = [];
  let branchInfo: string | null = null;
  let i = 0;
  while (i < records.length) {
    const rec = records[i];
    if (rec === undefined || rec === "") {
      i++;
      continue;
    }
    if (rec.startsWith("## ")) {
      branchInfo = rec.slice(3);
      i++;
      continue;
    }
    const indexStatus = rec.charAt(0);
    const workingStatus = rec.charAt(1);
    const path = rec.slice(3);
    const entry: GitStatusEntry = { path, indexStatus, workingStatus };
    // Rename/copy: next token is the original path.
    if (indexStatus === "R" || indexStatus === "C") {
      const orig = records[i + 1];
      if (orig !== undefined) {
        entry.renamedFrom = orig;
        i += 2;
      } else {
        i++;
      }
    } else {
      i++;
    }
    entries.push(entry);
  }
  return { entries, branchInfo };
}

function formatHuman(
  branch: string,
  branchInfo: string | null,
  entries: readonly GitStatusEntry[],
): string {
  const lines: string[] = [];
  lines.push(`# branch: ${branch}${branchInfo ? ` (${branchInfo})` : ""}`);
  if (entries.length === 0) {
    lines.push("(working tree clean)");
    return lines.join("\n");
  }
  for (const e of entries) {
    const mark = `${e.indexStatus || " "}${e.workingStatus || " "}`;
    const rename = e.renamedFrom ? `  (from ${e.renamedFrom})` : "";
    lines.push(`${mark} ${e.path}${rename}`);
  }
  return lines.join("\n");
}
