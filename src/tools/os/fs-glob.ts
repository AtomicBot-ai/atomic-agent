import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "./expand-home.js";
import type { ToolDefinition } from "../tool-registry.js";

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
];
const DEFAULT_LIMIT = 1000;

interface GlobArgs {
  patterns: string[];
  cwd: string;
  ignore: string[];
  absolute: boolean;
  limit: number;
  sortByMtime: boolean;
}

interface GlobEntry {
  path: string;
  mtimeMs: number;
}

export const osFsGlobTool: ToolDefinition = {
  name: "os.fs.glob",
  description:
    "Recursively find files matching one or more glob patterns. Supports `*` (any chars except `/`), `**` (any path segments), `?` (single char), and `{a,b}` brace expansion. Search root is `cwd` or `path` (same meaning; if both are set, `cwd` wins). Returns POSIX-style paths relative to that root by default.",
  readonly: true,
  async run(rawArgs, ctx) {
    const args = parseArgs(rawArgs, ctx.workingDir);
    const matchers = args.patterns.map(compileGlob);
    const ignoreMatchers = args.ignore.map(compileGlob);
    const fileMatches: GlobEntry[] = [];
    let totalScanned = 0;
    let truncated = false;

    async function walk(current: string): Promise<void> {
      let entries: Dirent[];
      try {
        entries = (await readdir(current, { withFileTypes: true })) as Dirent[];
      } catch {
        return;
      }
      for (const entry of entries) {
        if (fileMatches.length >= args.limit) {
          truncated = true;
          return;
        }
        const abs = join(current, entry.name);
        const rel = toPosix(relative(args.cwd, abs));
        if (rel.length === 0) continue;
        totalScanned++;
        const isDir = entry.isDirectory();
        const isFile = entry.isFile();
        const relForDir = isDir ? `${rel}/` : rel;
        if (matchesAny(ignoreMatchers, rel) || matchesAny(ignoreMatchers, relForDir)) {
          continue;
        }
        if (isFile && matchesAny(matchers, rel)) {
          try {
            const info = await stat(abs);
            fileMatches.push({ path: rel, mtimeMs: info.mtimeMs });
          } catch {
            fileMatches.push({ path: rel, mtimeMs: 0 });
          }
        }
        if (isDir) {
          await walk(abs);
          if (fileMatches.length >= args.limit) {
            truncated = true;
            return;
          }
        }
      }
    }

    await walk(args.cwd);

    if (args.sortByMtime) {
      fileMatches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    } else {
      fileMatches.sort((a, b) => a.path.localeCompare(b.path));
    }
    const finalPaths = fileMatches
      .slice(0, args.limit)
      .map((entry) => (args.absolute ? resolve(args.cwd, entry.path) : entry.path));
    const summary = finalPaths.join("\n");
    return compressToolResult(
      {
        tool: "os.fs.glob",
        status: "ok",
        output: summary.length > 0 ? summary : "(no matches)",
        details: {
          cwd: args.cwd,
          patterns: args.patterns,
          ignore: args.ignore,
          total: fileMatches.length,
          scanned: totalScanned,
          truncated,
          files: finalPaths,
        },
      },
      { maxSummaryLength: 8_000, maxTailLines: 500 },
    );
  },
};

function parseArgs(
  rawArgs: Record<string, unknown>,
  workingDir: string,
): GlobArgs {
  const patternRaw = rawArgs.pattern;
  const patterns: string[] = [];
  if (typeof patternRaw === "string") {
    if (patternRaw.length === 0) {
      throw new Error("os.fs.glob: `pattern` must be a non-empty string");
    }
    patterns.push(patternRaw);
  } else if (Array.isArray(patternRaw)) {
    for (const p of patternRaw) {
      if (typeof p !== "string" || p.length === 0) {
        throw new Error("os.fs.glob: `pattern[]` entries must be non-empty strings");
      }
      patterns.push(p);
    }
    if (patterns.length === 0) {
      throw new Error("os.fs.glob: `pattern` array must contain at least one pattern");
    }
  } else {
    throw new Error("os.fs.glob: `pattern` is required (string or string[])");
  }
  const cwdExplicit =
    typeof rawArgs.cwd === "string" && rawArgs.cwd.length > 0
      ? rawArgs.cwd
      : null;
  const pathAsRoot =
    typeof rawArgs.path === "string" && rawArgs.path.length > 0
      ? rawArgs.path
      : null;
  const cwdArg = cwdExplicit ?? pathAsRoot ?? workingDir;
  const cwd = resolveUserPath(cwdArg, workingDir);
  const ignore = Array.isArray(rawArgs.ignore)
    ? rawArgs.ignore.filter((v): v is string => typeof v === "string" && v.length > 0)
    : DEFAULT_IGNORE;
  const absolute = rawArgs.absolute === true;
  const limit =
    typeof rawArgs.limit === "number" && Number.isFinite(rawArgs.limit)
      ? Math.max(1, Math.trunc(rawArgs.limit))
      : DEFAULT_LIMIT;
  const sortByMtime = rawArgs.sortByMtime === true;
  return { patterns, cwd, ignore, absolute, limit, sortByMtime };
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function matchesAny(matchers: RegExp[], path: string): boolean {
  for (const m of matchers) {
    if (m.test(path)) return true;
  }
  return false;
}

/**
 * Compile a glob pattern into a case-sensitive regex anchored at both ends.
 * Supports:
 *   - `*`     any chars except `/`
 *   - `**`    any number of path segments (including zero)
 *   - `?`     exactly one char except `/`
 *   - `{a,b}` alternation (one level, no nesting)
 *   - backslash-escaped literals
 *
 * Everything else is treated as a literal, with regex metachars escaped.
 */
export function compileGlob(pattern: string): RegExp {
  let re = "^";
  const len = pattern.length;
  let i = 0;
  while (i < len) {
    const c = pattern[i] as string;
    if (c === "\\" && i + 1 < len) {
      re += escapeRegexChar(pattern[i + 1] as string);
      i += 2;
      continue;
    }
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const prevIsBoundary = i === 0 || pattern[i - 1] === "/";
        const nextChar = pattern[i + 2];
        if (prevIsBoundary && nextChar === "/") {
          // `**/` — zero or more path segments.
          re += "(?:[^/]+/)*";
          i += 3;
          continue;
        }
        if (prevIsBoundary && nextChar === undefined) {
          re += ".*";
          i += 2;
          continue;
        }
        // Fallback: `**` in the middle of a segment behaves like `.*`.
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (c === "{") {
      const end = findMatchingBrace(pattern, i);
      if (end !== -1) {
        const inner = pattern.slice(i + 1, end);
        const parts = splitBraceAlternatives(inner).map((alt) =>
          alt
            .split("")
            .map((ch) => escapeRegexChar(ch))
            .join(""),
        );
        re += "(?:" + parts.join("|") + ")";
        i = end + 1;
        continue;
      }
      re += "\\{";
      i++;
      continue;
    }
    re += escapeRegexChar(c);
    i++;
  }
  re += "$";
  return new RegExp(re);
}

function escapeRegexChar(c: string): string {
  if (/[.+^$|()\\\[\]]/.test(c)) return "\\" + c;
  return c;
}

function findMatchingBrace(pattern: string, start: number): number {
  let depth = 0;
  for (let i = start; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitBraceAlternatives(inner: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let depth = 0;
  for (const ch of inner) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}
