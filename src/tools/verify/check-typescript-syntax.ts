/**
 * TypeScript: `tsc --noEmit` against the project's own `tsconfig.json`,
 * once per project, with the diagnostics attributed back to the files
 * that were asked about.
 *
 * Per-file `tsc a.ts` would ignore the tsconfig (paths, jsx, lib) and
 * fail on any import, so the project is the unit of checking. A file the
 * project does not include gets no verdict rather than a pass: tsc said
 * nothing about it.
 *
 * "No checker" when there is no tsconfig above the file or no `tsc`
 * under a `node_modules/.bin` above the project — a global `tsc` is
 * not consulted, since its version is not the project's.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { runChecker } from "./check-script-syntax.js";
import { type SyntaxFileResult, tailOfOutput } from "./syntax-check-types.js";

export const TS_CHECKER = "tsc --noEmit";
const TSC_TIMEOUT_MS = 300_000;

/** The nearest `tsconfig.json` at or above `dir`, or `null`. */
export function findTsconfig(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    const candidate = join(current, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The nearest `node_modules/.bin/tsc` at or above `dir`, or `null`. */
export function findTscBinary(dir: string): string | null {
  const name = process.platform === "win32" ? "tsc.cmd" : "tsc";
  let current = resolve(dir);
  for (;;) {
    const candidate = join(current, "node_modules", ".bin", name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

interface ProjectCheck {
  readonly ok: boolean;
  /** Absolute path → diagnostics naming it. */
  readonly diagnostics: ReadonlyMap<string, readonly string[]>;
  /** Absolute paths the project compiled (from `--listFiles`). */
  readonly included: ReadonlySet<string>;
  readonly errorCount: number;
  /** tsc itself failed (crash, timeout) — no verdict for anyone. */
  readonly failure: string | null;
}

const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): (error TS\d+: .*)$/;

async function checkProject(
  tsconfig: string,
  tsc: string,
): Promise<ProjectCheck> {
  const projectDir = dirname(tsconfig);
  const run = await runChecker(
    tsc,
    ["--noEmit", "-p", tsconfig, "--pretty", "false", "--listFiles"],
    { cwd: projectDir, timeoutMs: TSC_TIMEOUT_MS },
  );
  if (run.missing) {
    return { ok: false, diagnostics: new Map(), included: new Set(), errorCount: 0, failure: "tsc could not be started" };
  }
  if (run.timedOut) {
    return { ok: false, diagnostics: new Map(), included: new Set(), errorCount: 0, failure: "tsc timed out" };
  }
  const diagnostics = new Map<string, string[]>();
  const included = new Set<string>();
  let errorCount = 0;
  for (const raw of run.stdout.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const match = line.match(DIAGNOSTIC);
    if (match) {
      const path = resolve(projectDir, match[1]!);
      errorCount += 1;
      const list = diagnostics.get(path) ?? [];
      list.push(`line ${match[2]}: ${match[4]}`);
      diagnostics.set(path, list);
      continue;
    }
    if (isAbsolute(line) && !line.includes(": ")) included.add(resolve(line));
  }
  if (run.exitCode !== 0 && errorCount === 0) {
    // Exit 1 with no `file(line,col)` diagnostics: a config error or a
    // crash, and tsc printed why to stdout or stderr.
    return {
      ok: false,
      diagnostics,
      included,
      errorCount,
      failure: tailOfOutput(`${run.stdout}\n${run.stderr}`, 4) || `tsc exited ${run.exitCode}`,
    };
  }
  return { ok: run.exitCode === 0, diagnostics, included, errorCount, failure: null };
}

function withoutVerdict(file: string, error: string): SyntaxFileResult {
  return { file, ok: null, checker: "none", error };
}

/**
 * Check `.ts` / `.tsx` files (given as `{file, absolute}` pairs). Files
 * that share a tsconfig share one `tsc` run.
 */
export async function checkTypeScriptFiles(
  files: readonly { file: string; absolute: string }[],
): Promise<SyntaxFileResult[]> {
  const byProject = new Map<string, { file: string; absolute: string }[]>();
  const results = new Map<string, SyntaxFileResult>();
  for (const entry of files) {
    const tsconfig = findTsconfig(dirname(entry.absolute));
    if (tsconfig === null) {
      results.set(entry.absolute, withoutVerdict(entry.file, "no tsconfig.json above the file"));
      continue;
    }
    const group = byProject.get(tsconfig) ?? [];
    group.push(entry);
    byProject.set(tsconfig, group);
  }
  for (const [tsconfig, group] of byProject) {
    const projectDir = dirname(tsconfig);
    const tsc = findTscBinary(projectDir);
    if (tsc === null) {
      for (const entry of group) {
        results.set(entry.absolute, withoutVerdict(entry.file, `no node_modules/.bin/tsc above ${projectDir}`));
      }
      continue;
    }
    const project = await checkProject(tsconfig, tsc);
    for (const entry of group) {
      results.set(entry.absolute, attribute(entry, project, tsconfig));
    }
  }
  return files.map((entry) => results.get(entry.absolute)!);
}

function attribute(
  entry: { file: string; absolute: string },
  project: ProjectCheck,
  tsconfig: string,
): SyntaxFileResult {
  const { file, absolute } = entry;
  if (project.failure !== null) {
    return { file, ok: null, checker: TS_CHECKER, error: project.failure };
  }
  const own = project.diagnostics.get(absolute);
  if (own !== undefined) {
    const shown = own.slice(0, 3).join("; ");
    const more = own.length > 3 ? ` (+${own.length - 3} more)` : "";
    return { file, ok: false, checker: TS_CHECKER, error: `${shown}${more}` };
  }
  if (!project.included.has(absolute)) {
    return withoutVerdict(file, `not included by ${tsconfig}`);
  }
  if (project.errorCount > 0) {
    return {
      file,
      ok: true,
      checker: TS_CHECKER,
      warning: `tsc reported ${project.errorCount} error(s) in other files of ${dirname(tsconfig)}`,
    };
  }
  return { file, ok: true, checker: TS_CHECKER };
}
