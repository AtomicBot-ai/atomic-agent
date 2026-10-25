import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { resolveUserPath } from "../expand-home.js";

export type GrepOutputMode = "content" | "files_with_matches" | "count";

export interface GrepArgs {
  pattern: string;
  path: string;
  glob: string[];
  type: string | undefined;
  caseInsensitive: boolean;
  multiline: boolean;
  /** Search for the pattern as a fixed string (`rg -F`), not a regex. */
  literal: boolean;
  outputMode: GrepOutputMode;
  contextBefore: number;
  contextAfter: number;
  headLimit: number;
  offset: number;
  showLineNumbers: boolean;
  timeoutMs: number;
}

/**
 * ripgrep's time limit when the call names none. The grep contract quotes
 * it to the model (contracts stay import-free); a test keeps them in step.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HEAD_LIMIT = 200;

export function parseArgs(
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
  const literal = rawArgs.literal === true;
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
    literal,
    outputMode,
    contextBefore,
    contextAfter,
    headLimit,
    offset,
    showLineNumbers,
    timeoutMs,
  };
}

export interface SearchTarget {
  /** Directory the ripgrep child process is spawned in. Always a directory. */
  cwd: string;
  /** Positional target handed to ripgrep, relative to `cwd`. */
  searchTarget: string;
}

/**
 * Work out where to spawn ripgrep and what to point it at.
 *
 * `spawn` requires `cwd` to be a directory, so passing a file path straight
 * through fails with `ENOTDIR` before ripgrep ever runs. A file is therefore
 * searched from its parent directory, with the file name as the positional
 * target; a directory keeps the previous behaviour (`cwd` = the directory,
 * target = `.`) so glob and type filters resolve the same way as before.
 */
export async function resolveSearchTarget(
  path: string,
  workingDir: string,
): Promise<SearchTarget> {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`os.fs.grep: path does not exist: ${path}`);
    }
    throw new Error(
      `os.fs.grep: cannot access path ${path}: ${(err as Error).message}`,
    );
  }
  if (info.isDirectory()) {
    return { cwd: path, searchTarget: "." };
  }
  const parent = dirname(path);
  // `dirname` of a filesystem root returns the root itself; fall back to the
  // working directory only when the parent is somehow unusable.
  const cwd = parent.length > 0 ? parent : workingDir;
  return { cwd, searchTarget: basename(path) };
}

export function buildRgArgs(args: GrepArgs, searchTarget: string): string[] {
  const rg: string[] = ["--json"];
  if (args.caseInsensitive) rg.push("-i");
  if (args.literal) rg.push("-F");
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
  rg.push("--", args.pattern, searchTarget);
  return rg;
}
