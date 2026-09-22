import { compressToolResult } from "../../../compressor/result-compressor.js";
import { listingResultCaps } from "../../../compressor/listing-caps.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { requireGitSuccess, runGit } from "./git-runner.js";

/**
 * Structured commit record. Fields mirror the common subset of
 * `git log --pretty` formats; we don't expose signature status or
 * tree/parent hashes to keep the surface area small.
 */
export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  body?: string;
}

/**
 * We encode each commit on a single line using NUL-byte separators
 * between fields (so multi-line subjects never confuse the parser) and
 * RECORD_SEP between commits. `\x1e` (RS) is the ASCII record separator —
 * practically never appears in commit messages.
 */
const RS = "\x1e";
const US = "\x1f";
const LOG_FORMAT = `%H${US}%h${US}%an${US}%ae${US}%aI${US}%s${US}%b${RS}`;

/**
 * Estimated width of one commit's two rendered lines: ~80 for
 * `shortHash  ISO-date  author`, plus the indented subject, which
 * nothing here clamps. An estimate, not a ceiling.
 */
const COMMIT_CHARS = 240;

export const osGitLogTool: ToolDefinition = {
  name: "os.git.log",
  description:
    "Show commit history. Optional args: limit (default 20), revisionRange (e.g. 'main..HEAD'), path (filter by file). Returns structured commit records.",
  readonly: true,
  async run(rawArgs, ctx) {
    const repo = typeof rawArgs.repo === "string" ? rawArgs.repo : undefined;
    const limit = parseLimit(rawArgs.limit, 20);
    const revisionRange = parseOptionalString(rawArgs.revisionRange);
    const filterPath = parseOptionalString(rawArgs.path);

    const args: string[] = [
      "log",
      `--pretty=format:${LOG_FORMAT}`,
      `-n`,
      String(limit),
    ];
    if (revisionRange) args.push(revisionRange);
    if (filterPath) args.push("--", filterPath);

    const result = await runGit({
      repo,
      workingDir: ctx.workingDir,
      args,
      signal: ctx.signal,
      timeoutMs: 20_000,
    });
    requireGitSuccess("os.git.log", result);

    const entries = parseLog(result.stdout);
    const human = formatHumanLog(entries);

    return compressToolResult(
      {
        tool: "os.git.log",
        status: "ok",
        output: human,
        details: {
          count: entries.length,
          entries,
          revisionRange: revisionRange ?? null,
          path: filterPath ?? null,
          repoRoot: result.repoRoot,
        },
      },
      // `git log` is newest-first and `formatHumanLog` spends TWO
      // lines on each commit, so the default 12-line tail keeps the
      // OLDEST four and the 385-char head-slice then leaves ~2. Budget
      // the commits we actually asked git for: `limit` (20 by default,
      // 1000 max) x COMMIT_CHARS — a default call asks for ~5 KB and
      // is held to the shared ceiling; `limit: 1000` asks for 240 KB
      // and gets the ceiling too, which measured out at ~40 real
      // commits, ten times the four the defaults left.
      listingResultCaps(limit, COMMIT_CHARS),
    );
  },
};

function parseLimit(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error("os.git.log: `limit` must be a positive number");
  }
  return Math.min(1000, Math.floor(raw));
}

function parseOptionalString(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return raw;
}

function parseLog(stdout: string): GitLogEntry[] {
  if (!stdout) return [];
  const records = stdout.split(RS);
  const entries: GitLogEntry[] = [];
  for (const rec of records) {
    const trimmed = rec.replace(/^\n+/, "");
    if (!trimmed) continue;
    const fields = trimmed.split(US);
    if (fields.length < 7) continue;
    const [hash, shortHash, author, authorEmail, date, subject, body] =
      fields as [string, string, string, string, string, string, string];
    const entry: GitLogEntry = {
      hash,
      shortHash,
      author,
      authorEmail,
      date,
      subject,
    };
    const cleanBody = body?.replace(/\n+$/, "");
    if (cleanBody) entry.body = cleanBody;
    entries.push(entry);
  }
  return entries;
}

function formatHumanLog(entries: readonly GitLogEntry[]): string {
  if (entries.length === 0) return "(no commits)";
  return entries
    .map((e) => `${e.shortHash}  ${e.date}  ${e.author}\n    ${e.subject}`)
    .join("\n");
}
