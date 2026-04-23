import { compressToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "./expand-home.js";
import {
  runCommand as defaultRunCommand,
  type CommandResult,
} from "../../sandbox/command-runner.js";
import {
  resolveRipgrepPath,
  RIPGREP_MISSING_HINT,
} from "../../runtime/ripgrep-resolver.js";
import type { ToolDefinition } from "../tool-registry.js";

export type GrepOutputMode = "content" | "files_with_matches" | "count";

export interface FsGrepDependencies {
  resolveRgPath: () => string | null;
  runCommand: typeof defaultRunCommand;
}

interface GrepArgs {
  pattern: string;
  path: string;
  glob: string[];
  type: string | undefined;
  caseInsensitive: boolean;
  multiline: boolean;
  outputMode: GrepOutputMode;
  contextBefore: number;
  contextAfter: number;
  headLimit: number;
  offset: number;
  showLineNumbers: boolean;
  timeoutMs: number;
}

interface RgMatchRecord {
  lineNumber: number;
  text: string;
  submatches: Array<{ start: number; end: number; text: string }>;
  isContext: boolean;
}

interface RgFileRecord {
  path: string;
  matches: RgMatchRecord[];
  matchCount: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HEAD_LIMIT = 200;

export function buildOsFsGrepTool(
  deps: Partial<FsGrepDependencies> = {},
): ToolDefinition {
  const resolveRgPath = deps.resolveRgPath ?? (() => resolveRipgrepPath());
  const runCommand = deps.runCommand ?? defaultRunCommand;

  return {
    name: "os.fs.grep",
    description:
      "Fast regex search across files using bundled ripgrep. Supports three output modes (`content`, `files_with_matches`, `count`), glob filtering, file-type filtering, multiline mode, context lines, and pagination. Read-only.",
    readonly: true,
    async run(rawArgs, ctx) {
      const args = parseArgs(rawArgs, ctx.workingDir);
      const rgPath = resolveRgPath();
      if (!rgPath) {
        return compressToolResult({
          tool: "os.fs.grep",
          status: "error",
          output: RIPGREP_MISSING_HINT,
          details: { missing: true, hint: RIPGREP_MISSING_HINT },
        });
      }

      const rgArgs = buildRgArgs(args);
      const result = await runCommand(rgPath, rgArgs, {
        cwd: args.path,
        timeoutMs: args.timeoutMs,
        signal: ctx.signal,
      });

      // ripgrep exits 1 on no matches, 0 on matches, 2+ on error.
      if (result.exitCode === 1) {
        return compressToolResult({
          tool: "os.fs.grep",
          status: "ok",
          output: "(no matches)",
          details: {
            totals: { files: 0, matches: 0 },
            files: [],
            truncated: false,
            command: [rgPath, ...rgArgs],
            path: args.path,
          },
        });
      }
      if (result.exitCode !== 0) {
        const reason = result.stderr.trim().length > 0
          ? result.stderr.trim()
          : `ripgrep exited with code ${result.exitCode}`;
        return compressToolResult({
          tool: "os.fs.grep",
          status: "error",
          output: reason,
          details: {
            exitCode: result.exitCode,
            command: [rgPath, ...rgArgs],
            path: args.path,
          },
        });
      }

      const files = parseRipgrepJson(result.stdout);
      return formatGrepResult(args, files, rgPath, rgArgs, result);
    },
  };
}

function parseArgs(
  rawArgs: Record<string, unknown>,
  workingDir: string,
): GrepArgs {
  const pattern = rawArgs.pattern;
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("os.fs.grep: `pattern` must be a non-empty string");
  }
  const pathRaw =
    typeof rawArgs.path === "string" && rawArgs.path.length > 0
      ? rawArgs.path
      : workingDir;
  const path = resolveUserPath(pathRaw, workingDir);
  const globRaw = rawArgs.glob;
  const glob: string[] = [];
  if (typeof globRaw === "string" && globRaw.length > 0) {
    glob.push(globRaw);
  } else if (Array.isArray(globRaw)) {
    for (const g of globRaw) {
      if (typeof g === "string" && g.length > 0) glob.push(g);
    }
  }
  const type =
    typeof rawArgs.type === "string" && rawArgs.type.length > 0
      ? rawArgs.type
      : undefined;
  const caseInsensitive = rawArgs.caseInsensitive === true;
  const multiline = rawArgs.multiline === true;
  const modeRaw = rawArgs.outputMode;
  const outputMode: GrepOutputMode =
    modeRaw === "files_with_matches" || modeRaw === "count"
      ? modeRaw
      : "content";
  const contextAround =
    typeof rawArgs.contextAround === "number" &&
    Number.isFinite(rawArgs.contextAround)
      ? Math.max(0, Math.trunc(rawArgs.contextAround))
      : 0;
  const contextBefore =
    typeof rawArgs.contextBefore === "number" &&
    Number.isFinite(rawArgs.contextBefore)
      ? Math.max(0, Math.trunc(rawArgs.contextBefore))
      : contextAround;
  const contextAfter =
    typeof rawArgs.contextAfter === "number" &&
    Number.isFinite(rawArgs.contextAfter)
      ? Math.max(0, Math.trunc(rawArgs.contextAfter))
      : contextAround;
  const headLimit =
    typeof rawArgs.headLimit === "number" && Number.isFinite(rawArgs.headLimit)
      ? Math.max(1, Math.trunc(rawArgs.headLimit))
      : DEFAULT_HEAD_LIMIT;
  const offset =
    typeof rawArgs.offset === "number" && Number.isFinite(rawArgs.offset)
      ? Math.max(0, Math.trunc(rawArgs.offset))
      : 0;
  const showLineNumbers = rawArgs.showLineNumbers !== false;
  const timeoutMs =
    typeof rawArgs.timeoutMs === "number" && Number.isFinite(rawArgs.timeoutMs)
      ? Math.max(1, Math.trunc(rawArgs.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
  return {
    pattern,
    path,
    glob,
    type,
    caseInsensitive,
    multiline,
    outputMode,
    contextBefore,
    contextAfter,
    headLimit,
    offset,
    showLineNumbers,
    timeoutMs,
  };
}

function buildRgArgs(args: GrepArgs): string[] {
  const rg: string[] = ["--json"];
  if (args.caseInsensitive) rg.push("-i");
  if (args.multiline) {
    rg.push("-U");
    rg.push("--multiline-dotall");
  }
  if (args.contextBefore > 0) rg.push("-B", String(args.contextBefore));
  if (args.contextAfter > 0) rg.push("-A", String(args.contextAfter));
  for (const g of args.glob) {
    rg.push("--glob", g);
  }
  if (args.type) rg.push("--type", args.type);
  rg.push("--", args.pattern, ".");
  return rg;
}

interface RgJsonEnvelope {
  type: "begin" | "match" | "context" | "end" | "summary";
  data: Record<string, unknown>;
}

interface RgSubmatch {
  match: { text?: string } | undefined;
  start: number;
  end: number;
}

/**
 * Parse the NDJSON stream produced by `rg --json` into a flat list of
 * per-file records. The ripgrep envelope is documented here:
 *   https://docs.rs/grep-printer/latest/grep_printer/#json-output
 *
 * We only care about `match` and `context` records; `begin`/`end`/`summary`
 * are used to delimit file boundaries without allocating extra state.
 */
export function parseRipgrepJson(stdout: string): RgFileRecord[] {
  const files = new Map<string, RgFileRecord>();
  const lines = stdout.split("\n");
  for (const rawLine of lines) {
    if (rawLine.length === 0) continue;
    let envelope: RgJsonEnvelope;
    try {
      envelope = JSON.parse(rawLine) as RgJsonEnvelope;
    } catch {
      continue;
    }
    if (envelope.type !== "match" && envelope.type !== "context") continue;
    const path = extractText(envelope.data.path);
    if (path === undefined) continue;
    const lineNumber = typeof envelope.data.line_number === "number"
      ? envelope.data.line_number
      : 0;
    const text = extractText(envelope.data.lines) ?? "";
    const submatchesRaw = Array.isArray(envelope.data.submatches)
      ? (envelope.data.submatches as RgSubmatch[])
      : [];
    const submatches = submatchesRaw.map((sm) => ({
      start: typeof sm.start === "number" ? sm.start : 0,
      end: typeof sm.end === "number" ? sm.end : 0,
      text: extractText(sm.match) ?? "",
    }));
    const existing = files.get(path) ?? {
      path,
      matches: [],
      matchCount: 0,
    };
    existing.matches.push({
      lineNumber,
      text: text.replace(/\r?\n$/, ""),
      submatches,
      isContext: envelope.type === "context",
    });
    if (envelope.type === "match") existing.matchCount++;
    files.set(path, existing);
  }
  return Array.from(files.values());
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const text = (value as Record<string, unknown>).text;
    if (typeof text === "string") return text;
    const bytes = (value as Record<string, unknown>).bytes;
    if (typeof bytes === "string") {
      try {
        return Buffer.from(bytes, "base64").toString("utf8");
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function formatGrepResult(
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
          counts: paged.slice.map((f) => ({ path: f.path, count: f.matchCount })),
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
  const body = segments.length > 0
    ? segments.join("\n").trimEnd()
    : "(no matches)";
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
