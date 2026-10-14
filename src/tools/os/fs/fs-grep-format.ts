import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { CommandResult } from "../../../sandbox/command-runner.js";
import type { GrepArgs } from "./fs-grep-args.js";
import type { RgFileRecord, RgMatchRecord } from "./fs-grep-ripgrep-json.js";

export function formatGrepResult(
  args: GrepArgs,
  files: RgFileRecord[],
  rgPath: string,
  rgArgs: string[],
  result: CommandResult,
): ReturnType<typeof compressToolResult> {
  const totalFiles = files.length;
  const totalMatches = files.reduce((acc, f) => acc + f.matchCount, 0);

  if (args.outputMode === "files_with_matches") {
    const paged = paginate(files, args.offset, args.headLimit);
    const lines = paged.slice.map((f) => f.path);
    const body = lines.length > 0 ? lines.join("\n") : "(no matches)";
    return compressToolResult(
      {
        tool: "os.fs.grep",
        status: "ok",
        output: body,
        details: {
          outputMode: args.outputMode,
          totals: { files: totalFiles, matches: totalMatches },
          files: paged.slice.map((f) => f.path),
          truncated: paged.truncated || result.truncated,
          command: [rgPath, ...rgArgs],
          path: args.path,
        },
      },
      { maxSummaryLength: 8_000, maxTailLines: 500 },
    );
  }

  if (args.outputMode === "count") {
    const paged = paginate(files, args.offset, args.headLimit);
    const lines = paged.slice.map((f) => `${f.path}:${f.matchCount}`);
    const body = lines.length > 0 ? lines.join("\n") : "(no matches)";
    return compressToolResult(
      {
        tool: "os.fs.grep",
        status: "ok",
        output: body,
        details: {
          outputMode: args.outputMode,
          totals: { files: totalFiles, matches: totalMatches },
          counts: paged.slice.map((f) => ({
            path: f.path,
            count: f.matchCount,
          })),
          truncated: paged.truncated || result.truncated,
          command: [rgPath, ...rgArgs],
          path: args.path,
        },
      },
      { maxSummaryLength: 8_000, maxTailLines: 500 },
    );
  }

  // content mode — paginate across matches (not files) so headLimit
  // behaves like ripgrep's `--max-count` at the match level.
  const flat: Array<{ file: RgFileRecord; match: RgMatchRecord }> = [];
  for (const file of files) {
    for (const match of file.matches) {
      flat.push({ file, match });
    }
  }
  const paged = paginate(flat, args.offset, args.headLimit);
  const grouped = groupByFile(paged.slice);
  const segments: string[] = [];
  for (const group of grouped) {
    segments.push(`${group.path}:`);
    for (const match of group.matches) {
      const marker = match.isContext ? "-" : ":";
      if (args.showLineNumbers && match.lineNumber > 0) {
        segments.push(`${match.lineNumber}${marker} ${match.text}`);
      } else {
        segments.push(`  ${match.text}`);
      }
    }
    segments.push("");
  }
  const body =
    segments.length > 0 ? segments.join("\n").trimEnd() : "(no matches)";
  return compressToolResult(
    {
      tool: "os.fs.grep",
      status: "ok",
      output: body,
      details: {
        outputMode: args.outputMode,
        totals: { files: totalFiles, matches: totalMatches },
        files: grouped.map((g) => ({
          path: g.path,
          matches: g.matches.map((m) => ({
            lineNumber: m.lineNumber,
            text: m.text,
            submatches: m.submatches,
          })),
        })),
        truncated: paged.truncated || result.truncated,
        command: [rgPath, ...rgArgs],
        path: args.path,
      },
    },
    { maxSummaryLength: 12_000, maxTailLines: 800 },
  );
}

function paginate<T>(
  items: T[],
  offset: number,
  limit: number,
): { slice: T[]; truncated: boolean } {
  if (items.length === 0) return { slice: [], truncated: false };
  const start = Math.min(items.length, offset);
  const end = Math.min(items.length, start + limit);
  return {
    slice: items.slice(start, end),
    truncated: end < items.length,
  };
}

function groupByFile(
  flat: Array<{ file: RgFileRecord; match: RgMatchRecord }>,
): RgFileRecord[] {
  const byPath = new Map<string, RgFileRecord>();
  for (const { file, match } of flat) {
    const existing = byPath.get(file.path) ?? {
      path: file.path,
      matches: [],
      matchCount: 0,
    };
    existing.matches.push(match);
    if (!match.isContext) existing.matchCount++;
    byPath.set(file.path, existing);
  }
  return Array.from(byPath.values());
}
