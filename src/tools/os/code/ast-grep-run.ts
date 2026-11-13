import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand as defaultRunCommand, type CommandResult } from "../../../sandbox/command-runner.js";
import { resolveUserPath } from "../expand-home.js";
import { parseAstGrepJson, type AstGrepMatch } from "./ast-grep-json.js";
import { resolveAstGrepPath } from "./ast-grep-resolver.js";

/** What both structural code tools need from the outside; tests inject fakes. */
export interface AstGrepDependencies {
  resolveAstGrepPath: () => string | null;
  runCommand: typeof defaultRunCommand;
  /** The empty `sgconfig.yml` every run is pinned to (see `neutralAstGrepConfig`). */
  neutralConfig: () => Promise<string>;
}

export function astGrepDependencies(
  deps: Partial<AstGrepDependencies> = {},
): AstGrepDependencies {
  return {
    resolveAstGrepPath: deps.resolveAstGrepPath ?? (() => resolveAstGrepPath()),
    runCommand: deps.runCommand ?? defaultRunCommand,
    neutralConfig: deps.neutralConfig ?? neutralAstGrepConfig,
  };
}

/**
 * ast-grep reads `sgconfig.yml` from the folder it runs in and the ones
 * above it, and that file can name `customLanguages.*.libraryPath`, a
 * native library ast-grep then loads. A cloned repository must not get
 * code run by an unapproved `os.code.search`, so every run gets
 * `--config` pointing at this empty config and a cwd outside the
 * project: the project's own sgconfig is never read. Created once per
 * process in the system temp folder.
 */
let neutralConfigPath: Promise<string> | undefined;
export function neutralAstGrepConfig(): Promise<string> {
  neutralConfigPath ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-ast-grep-"));
    const file = join(dir, "sgconfig.yml");
    await writeFile(file, "ruleDirs: []\n", "utf8");
    return file;
  })().catch((err: unknown) => {
    neutralConfigPath = undefined;
    throw err;
  });
  return neutralConfigPath;
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

/**
 * The argv after the binary. The target is absolute, so every printed
 * `file` is too. `config` is the neutral sgconfig: never the project's.
 */
export function buildAstGrepArgs(query: AstGrepQuery, target: string, config: string): string[] {
  const args = ["run", "--config", config, "--pattern", query.pattern];
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
  const config = await deps.neutralConfig();
  const argv = buildAstGrepArgs(query, target, config);
  ctx.signal.throwIfAborted();
  const result = await deps.runCommand(binary, argv, {
    // Not the project: ast-grep looks for sgconfig.yml from its cwd up.
    cwd: dirname(config),
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
