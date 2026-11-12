import { stat } from "node:fs/promises";
import { runCommand as defaultRunCommand, type CommandResult } from "../../../sandbox/command-runner.js";
import { resolveUserPath } from "../expand-home.js";
import { parseAstGrepJson, type AstGrepMatch } from "./ast-grep-json.js";
import { resolveAstGrepPath } from "./ast-grep-resolver.js";

/** What both structural code tools need from the outside; tests inject fakes. */
export interface AstGrepDependencies {
  resolveAstGrepPath: () => string | null;
  runCommand: typeof defaultRunCommand;
}

export function astGrepDependencies(
  deps: Partial<AstGrepDependencies> = {},
): AstGrepDependencies {
  return {
    resolveAstGrepPath: deps.resolveAstGrepPath ?? (() => resolveAstGrepPath()),
    runCommand: deps.runCommand ?? defaultRunCommand,
  };
}

export const AST_GREP_DEFAULT_TIMEOUT_MS = 30_000;
export const AST_GREP_MAX_TIMEOUT_MS = 300_000;

export interface AstGrepQuery {
  pattern: string;
  /** Present for a rewrite (may be empty: delete the match). */
  rewrite?: string;
  lang?: string;
  /** As the model wrote it; omitted searches the working directory. */
  path?: string;
  globs: string[];
  timeoutMs: number;
}

/**
 * Validate the shared arguments. `tool` names the caller in errors.
 * `rewrite` is read only when `withRewrite`.
 */
export function parseAstGrepQuery(
  raw: Record<string, unknown>,
  tool: string,
  withRewrite: boolean,
): AstGrepQuery {
  const pattern = raw.pattern;
  if (typeof pattern !== "string" || pattern.trim().length === 0) {
    throw new Error(`${tool}: \`pattern\` must be a non-empty string`);
  }
  let rewrite: string | undefined;
  if (withRewrite) {
    if (typeof raw.rewrite !== "string") {
      throw new Error(`${tool}: \`rewrite\` must be a string (empty deletes each match)`);
    }
    rewrite = raw.rewrite;
  }
  const lang = optionalString(raw.lang, "lang", tool);
  const path = optionalString(raw.path, "path", tool);
  const globsRaw = raw.globs;
  let globs: string[] = [];
  if (globsRaw !== undefined && globsRaw !== null) {
    const list = typeof globsRaw === "string" ? [globsRaw] : globsRaw;
    if (!Array.isArray(list) || list.some((g) => typeof g !== "string")) {
      throw new Error(`${tool}: \`globs\` must be an array of strings`);
    }
    globs = (list as string[]).map((g) => g.trim()).filter((g) => g.length > 0);
  }
  const timeoutRaw = raw.timeoutMs;
  let timeoutMs = AST_GREP_DEFAULT_TIMEOUT_MS;
  if (timeoutRaw !== undefined && timeoutRaw !== null) {
    if (typeof timeoutRaw !== "number" || !Number.isFinite(timeoutRaw) || timeoutRaw <= 0) {
      throw new Error(`${tool}: \`timeoutMs\` must be a positive number`);
    }
    timeoutMs = Math.min(Math.floor(timeoutRaw), AST_GREP_MAX_TIMEOUT_MS);
  }
  return {
    pattern,
    ...(rewrite !== undefined ? { rewrite } : {}),
    ...(lang !== undefined ? { lang } : {}),
    ...(path !== undefined ? { path } : {}),
    globs,
    timeoutMs,
  };
}

function optionalString(value: unknown, field: string, tool: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${tool}: \`${field}\` must be a non-empty string when given`);
  }
  return value.trim();
}

/** The argv after the binary. The target is absolute, so every printed `file` is too. */
export function buildAstGrepArgs(query: AstGrepQuery, target: string): string[] {
  const args = ["run", "--pattern", query.pattern];
  if (query.rewrite !== undefined) args.push("--rewrite", query.rewrite);
  if (query.lang !== undefined) args.push("--lang", query.lang);
  for (const glob of query.globs) args.push("--globs", glob);
  args.push("--json=stream", "--", target);
  return args;
}

export type AstGrepOutcome =
  | {
      kind: "ok";
      matches: AstGrepMatch[];
      result: CommandResult;
      command: string[];
      target: string;
    }
  | { kind: "error"; message: string; details: Record<string, unknown> };

/**
 * Resolve the target, run ast-grep and parse what it printed. ast-grep
 * exits 0 with matches and 1 without (versions differ); either is a
 * result when nothing went to stderr. Anything else is an error carrying
 * ast-grep's own message (a pattern that does not parse, an unknown
 * language).
 */
export async function runAstGrep(
  query: AstGrepQuery,
  binary: string,
  deps: AstGrepDependencies,
  ctx: { workingDir: string; signal: AbortSignal },
  maxOutputBytes: number,
): Promise<AstGrepOutcome> {
  const target = query.path === undefined
    ? ctx.workingDir
    : resolveUserPath(query.path, ctx.workingDir);
  try {
    await stat(target);
  } catch (err) {
    return {
      kind: "error",
      message: `path not found: ${query.path ?? target} (${(err as NodeJS.ErrnoException).code ?? "error"})`,
      details: { path: query.path ?? target, missing: true },
    };
  }
  const argv = buildAstGrepArgs(query, target);
  ctx.signal.throwIfAborted();
  const result = await deps.runCommand(binary, argv, {
    cwd: ctx.workingDir,
    timeoutMs: query.timeoutMs,
    signal: ctx.signal,
    maxOutputBytes,
  });
  ctx.signal.throwIfAborted();
  const command = [binary, ...argv];
  const stderr = result.stderr.trim();
  if (result.timedOut) {
    return {
      kind: "ok",
      matches: parseAstGrepJson(result.stdout),
      result,
      command,
      target,
    };
  }
  if (result.exitCode === 0 || (result.exitCode === 1 && stderr.length === 0)) {
    return { kind: "ok", matches: parseAstGrepJson(result.stdout), result, command, target };
  }
  return {
    kind: "error",
    message: stderr.length > 0 ? `ast-grep: ${stderr}` : `ast-grep exited with code ${result.exitCode}`,
    details: { exitCode: result.exitCode, command },
  };
}
