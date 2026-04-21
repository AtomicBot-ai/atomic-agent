import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { requireGitSuccess, runGit } from "./git-runner.js";

export interface GitShowFileChange {
  path: string;
  addedLines: number;
  removedLines: number;
  binary: boolean;
  status: "A" | "M" | "D" | "R" | "C" | "T" | "U" | string;
}

export const osGitShowTool: ToolDefinition = {
  name: "os.git.show",
  description:
    "Show a commit (or any revision): metadata, message, and the patch. Arg `revision` is required (defaults to 'HEAD'). Arg `patch=false` suppresses the diff body.",
  readonly: true,
  async run(rawArgs, ctx) {
    const repo = typeof rawArgs.repo === "string" ? rawArgs.repo : undefined;
    const revision =
      typeof rawArgs.revision === "string" && rawArgs.revision.length > 0
        ? rawArgs.revision
        : "HEAD";
    const includePatch = rawArgs.patch !== false;

    // Grab metadata via a structured `show --format` call with no patch,
    // and — when requested — a second call for the patch itself. This
    // avoids having to parse free-form git show output.
    const metaFormat = "%H\x1f%an\x1f%ae\x1f%aI\x1f%s\x1f%b\x1e";
    const [metaResult, statResult, patchResult] = await Promise.all([
      runGit({
        repo,
        workingDir: ctx.workingDir,
        args: ["show", "--no-patch", `--format=${metaFormat}`, revision],
        signal: ctx.signal,
      }),
      runGit({
        repo,
        workingDir: ctx.workingDir,
        args: ["show", "--numstat", "--format=", revision],
        signal: ctx.signal,
      }),
      includePatch
        ? runGit({
            repo,
            workingDir: ctx.workingDir,
            args: ["show", "--format=", "--unified=3", revision],
            signal: ctx.signal,
            maxOutputBytes: 2 * 1024 * 1024,
          })
        : Promise.resolve(null),
    ]);
    requireGitSuccess("os.git.show", metaResult);
    requireGitSuccess("os.git.show", statResult);
    if (patchResult) requireGitSuccess("os.git.show", patchResult);

    const meta = parseMeta(metaResult.stdout);
    const files = parseNumstat(statResult.stdout);
    const patch = patchResult?.stdout ?? "";

    const human = formatHuman(meta, files, patch, includePatch);
    return compressToolResult(
      {
        tool: "os.git.show",
        status: "ok",
        output: human,
        details: {
          revision,
          commit: meta,
          files,
          fileCount: files.length,
          includePatch,
          repoRoot: metaResult.repoRoot,
        },
      },
      { maxSummaryLength: 64 * 1024, maxTailLines: 4000 },
    );
  },
};

interface GitShowMeta {
  hash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  body?: string;
}

function parseMeta(stdout: string): GitShowMeta {
  const trimmed = stdout.replace(/\x1e\s*$/, "").trim();
  const fields = trimmed.split("\x1f");
  if (fields.length < 5) {
    throw new Error("os.git.show: unable to parse commit metadata");
  }
  const [hash, author, authorEmail, date, subject, body] = fields as [
    string,
    string,
    string,
    string,
    string,
    string | undefined,
  ];
  const meta: GitShowMeta = {
    hash,
    author,
    authorEmail,
    date,
    subject,
  };
  const cleanBody = body?.replace(/\n+$/, "");
  if (cleanBody) meta.body = cleanBody;
  return meta;
}

function parseNumstat(stdout: string): GitShowFileChange[] {
  const out: GitShowFileChange[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [added, removed, path] = parts as [string, string, string];
    const binary = added === "-" && removed === "-";
    out.push({
      path,
      addedLines: binary ? 0 : Number(added),
      removedLines: binary ? 0 : Number(removed),
      binary,
      // --numstat doesn't report status chars; inferring them would
      // require a second call, so we leave it as "M" by default.
      status: "M",
    });
  }
  return out;
}

function formatHuman(
  meta: GitShowMeta,
  files: readonly GitShowFileChange[],
  patch: string,
  includePatch: boolean,
): string {
  const lines = [
    `commit ${meta.hash}`,
    `Author: ${meta.author} <${meta.authorEmail}>`,
    `Date:   ${meta.date}`,
    "",
    `    ${meta.subject}`,
  ];
  if (meta.body) {
    lines.push("");
    for (const b of meta.body.split("\n")) lines.push(`    ${b}`);
  }
  lines.push("");
  lines.push(`files: ${files.length}`);
  for (const f of files) {
    const stat = f.binary
      ? "bin"
      : `+${f.addedLines}/-${f.removedLines}`;
    lines.push(`  ${stat}  ${f.path}`);
  }
  if (includePatch && patch.trim().length > 0) {
    lines.push("");
    lines.push(patch.replace(/\n+$/, ""));
  }
  return lines.join("\n");
}
