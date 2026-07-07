import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { requireGitSuccess, runGit } from "./git-runner.js";

/**
 * One entry per source line in the blamed file. We keep the structured
 * list compact (no per-hunk grouping) because LLMs do best with a flat
 * stream of {line, commit, author, text}.
 */
export interface GitBlameLine {
  line: number;
  commit: string;
  author: string;
  authorTime: string;
  content: string;
}

export const osGitBlameTool: ToolDefinition = {
  name: "os.git.blame",
  description:
    "Show per-line authorship for a file. Args: `path` (required), `revision` (default 'HEAD'), `startLine`/`endLine` (optional 1-based range). Returns structured blame entries.",
  readonly: true,
  async run(rawArgs, ctx) {
    const repo = typeof rawArgs.repo === "string" ? rawArgs.repo : undefined;
    const path = rawArgs.path;
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("os.git.blame: `path` must be a non-empty string");
    }
    const revision =
      typeof rawArgs.revision === "string" && rawArgs.revision.length > 0
        ? rawArgs.revision
        : "HEAD";
    const startLine = parseLine(rawArgs.startLine, "startLine");
    const endLine = parseLine(rawArgs.endLine, "endLine");
    if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
      throw new Error("os.git.blame: endLine must be >= startLine");
    }

    const args: string[] = ["blame", "--porcelain"];
    if (startLine !== undefined || endLine !== undefined) {
      const lo = startLine ?? 1;
      const hi = endLine ?? startLine ?? lo;
      args.push("-L", `${lo},${hi}`);
    }
    args.push(revision, "--", path);

    const result = await runGit({
      repo,
      workingDir: ctx.workingDir,
      args,
      signal: ctx.signal,
      timeoutMs: 30_000,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    requireGitSuccess("os.git.blame", result);

    const entries = parsePorcelainBlame(result.stdout);
    const human = formatBlame(entries);

    return compressToolResult(
      {
        tool: "os.git.blame",
        status: "ok",
        output: human,
        details: {
          path,
          revision,
          lineCount: entries.length,
          entries,
          repoRoot: result.repoRoot,
        },
      },
      { maxSummaryLength: 64 * 1024, maxTailLines: 4000 },
    );
  },
};

function parseLine(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) {
    throw new Error(`os.git.blame: \`${field}\` must be a positive integer`);
  }
  return Math.floor(raw);
}

/**
 * `git blame --porcelain` layout per line:
 *   <sha> <srcLine> <resultLine> [<numLines>]  ← header
 *   author X
 *   author-mail <x@y>
 *   author-time 1234567890
 *   author-tz +0000
 *   ...more header fields, finally...
 *   filename path/to/file
 *   \t<file content verbatim>
 *
 * Subsequent lines of the same commit block only emit the minimal
 * `<sha> srcLine resultLine` header followed by `\t<content>`, so we
 * cache commit metadata keyed by sha.
 */
interface BlameCommit {
  author: string;
  authorTime: string;
}

function parsePorcelainBlame(stdout: string): GitBlameLine[] {
  const lines = stdout.split(/\r?\n/);
  const commits = new Map<string, BlameCommit>();
  const entries: GitBlameLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const headerLine = lines[i];
    if (!headerLine) {
      i++;
      continue;
    }
    const headerMatch = headerLine.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (!headerMatch) {
      i++;
      continue;
    }
    const sha = headerMatch[1]!;
    const resultLine = Number(headerMatch[2]);
    i++;
    let author = commits.get(sha)?.author ?? "(unknown)";
    let authorTime = commits.get(sha)?.authorTime ?? "";
    // Header extension lines until a `\t<content>` one.
    while (i < lines.length) {
      const extLine = lines[i];
      if (extLine === undefined) break;
      if (extLine.startsWith("\t")) {
        const content = extLine.slice(1);
        commits.set(sha, { author, authorTime });
        entries.push({
          line: resultLine,
          commit: sha.slice(0, 12),
          author,
          authorTime,
          content,
        });
        i++;
        break;
      }
      const spaceIdx = extLine.indexOf(" ");
      if (spaceIdx === -1) {
        i++;
        continue;
      }
      const key = extLine.slice(0, spaceIdx);
      const value = extLine.slice(spaceIdx + 1);
      if (key === "author") author = value;
      else if (key === "author-time") {
        const secs = Number(value);
        if (Number.isFinite(secs)) {
          authorTime = new Date(secs * 1000).toISOString();
        }
      }
      i++;
    }
  }
  return entries;
}

function formatBlame(entries: readonly GitBlameLine[]): string {
  return entries
    .map(
      (e) =>
        `${e.commit}  (${e.author.padEnd(16)}  ${e.authorTime.slice(0, 10)})  ${String(e.line).padStart(5)} | ${e.content}`,
    )
    .join("\n");
}
