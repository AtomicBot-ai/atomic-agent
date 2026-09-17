/**
 * `verify.syntax {files}` — one checker per file, chosen by extension.
 *
 * Read-only, and allowed on a fusion orchestrator's turn for that reason
 * (decision D1): reviewing a fan-out means looking at what came back,
 * and a syntax check is looking. It writes nothing anywhere near the
 * files — `node --check` is one process per file, Python is `compile()`
 * without bytecode, tsc runs `--noEmit`.
 *
 * The one rule that matters: a file this tool did not check is reported
 * as unchecked, never as passing. "No checker for .x" is a result.
 */
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "../os/expand-home.js";
import type { ToolDefinition } from "../tool-registry.js";
import { checkCssSource } from "./check-css-syntax.js";
import { checkHtmlSource } from "./check-html-syntax.js";
import {
  checkJavaScriptFile,
  checkPythonFile,
  checkShellFile,
} from "./check-script-syntax.js";
import { checkTypeScriptFiles } from "./check-typescript-syntax.js";
import type { SyntaxFileResult } from "./syntax-check-types.js";

export const VERIFY_SYNTAX_TOOL = "verify.syntax";
export const VERIFY_SYNTAX_MAX_FILES = 200;
export const VERIFY_SUMMARY_MAX_CHARS = 4_000;

const JS_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".json"]);
const TS_EXTENSIONS = new Set([".ts", ".tsx"]);
const SHELL_EXTENSIONS = new Set([".sh", ".bash"]);

export interface VerifySyntaxReport {
  readonly results: readonly SyntaxFileResult[];
  readonly passed: number;
  readonly failed: number;
  readonly unchecked: number;
  readonly summary: string;
}

export function parseVerifySyntaxArgs(raw: Record<string, unknown>): string[] {
  const files = raw.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("verify.syntax: `files` must be a non-empty array of paths");
  }
  if (files.length > VERIFY_SYNTAX_MAX_FILES) {
    throw new Error(
      `verify.syntax: at most ${VERIFY_SYNTAX_MAX_FILES} files per call (got ${files.length})`,
    );
  }
  const out: string[] = [];
  for (const entry of files) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error("verify.syntax: every entry of `files` must be a non-empty string");
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

async function checkOne(
  file: string,
  absolute: string,
): Promise<SyntaxFileResult> {
  const ext = extname(absolute).toLowerCase();
  if (JS_EXTENSIONS.has(ext)) {
    return checkJavaScriptFile(absolute, await readFile(absolute, "utf8")).then(
      (r) => ({ ...r, file }),
    );
  }
  if (ext === ".py") return { ...(await checkPythonFile(absolute)), file };
  if (SHELL_EXTENSIONS.has(ext)) return { ...(await checkShellFile(absolute)), file };
  if (ext === ".html" || ext === ".htm") {
    return { ...(await checkHtmlSource(file, await readFile(absolute, "utf8"))) };
  }
  if (ext === ".css") return checkCssSource(file, await readFile(absolute, "utf8"));
  return {
    file,
    ok: null,
    checker: "none",
    error: `no checker for ${ext.length > 0 ? ext : "files without an extension"}`,
  };
}

/** Check every file and render the report. Never throws for a bad file. */
export async function verifySyntax(
  files: readonly string[],
  workingDir: string,
): Promise<VerifySyntaxReport> {
  const results: SyntaxFileResult[] = new Array<SyntaxFileResult>(files.length);
  const typescript: { index: number; file: string; absolute: string }[] = [];
  for (const [index, file] of files.entries()) {
    const absolute = resolveUserPath(file, workingDir);
    try {
      const info = await stat(absolute);
      if (!info.isFile()) {
        results[index] = { file, ok: false, checker: "none", error: "not a regular file" };
        continue;
      }
    } catch {
      results[index] = { file, ok: false, checker: "none", error: "no such file" };
      continue;
    }
    if (TS_EXTENSIONS.has(extname(absolute).toLowerCase())) {
      typescript.push({ index, file, absolute });
      continue;
    }
    results[index] = await checkOne(file, absolute);
  }
  if (typescript.length > 0) {
    const verdicts = await checkTypeScriptFiles(typescript);
    for (const [i, entry] of typescript.entries()) {
      results[entry.index] = { ...verdicts[i]!, file: entry.file };
    }
  }
  return report(results);
}

function report(results: readonly SyntaxFileResult[]): VerifySyntaxReport {
  const failed = results.filter((r) => r.ok === false);
  const unchecked = results.filter((r) => r.ok === null);
  const passed = results.filter((r) => r.ok === true);
  const line = (r: SyntaxFileResult): string => {
    const mark = r.ok === true ? "ok" : r.ok === false ? "FAIL" : "unchecked";
    const why = r.error === undefined ? "" : ` — ${r.error}`;
    const warn = r.warning === undefined ? "" : ` ⚠ ${r.warning}`;
    return `${mark} ${r.file} [${r.checker}]${why}${warn}`;
  };
  const missingByExt = new Map<string, number>();
  for (const r of unchecked) {
    if (r.checker !== "none" || !r.error?.startsWith("no checker for ")) continue;
    const ext = r.error.slice("no checker for ".length);
    missingByExt.set(ext, (missingByExt.get(ext) ?? 0) + 1);
  }
  const head =
    `verify.syntax: ${passed.length} ok, ${failed.length} failed, ${unchecked.length} unchecked` +
    (unchecked.length > 0 ? " (unchecked files do not count as passing)" : "");
  const lines = [
    head,
    ...[...missingByExt].map(([ext, n]) => `no checker for ${ext} (${n} file${n === 1 ? "" : "s"})`),
    ...failed.map(line),
    ...unchecked.map(line),
    ...passed.map(line),
  ];
  let summary = lines.join("\n");
  if (summary.length > VERIFY_SUMMARY_MAX_CHARS) {
    summary = `${summary.slice(0, VERIFY_SUMMARY_MAX_CHARS - 12)}\n… [clipped]`;
  }
  return { results, passed: passed.length, failed: failed.length, unchecked: unchecked.length, summary };
}

export const verifySyntaxTool: ToolDefinition = {
  name: VERIFY_SYNTAX_TOOL,
  description:
    "Syntax-check files, one checker per file by extension: .js/.cjs/.mjs/.json in-process (then node --check), .ts/.tsx via the project's tsc --noEmit, .py via python3, .sh/.bash via bash -n, .html inline <script> blocks (plus a warning for content after </html>), .css brace balance. Read-only, writes nothing. A file with no checker is reported as unchecked, never as passing.",
  readonly: true,
  async run(rawArgs, ctx): Promise<CompressedToolResult> {
    const files = parseVerifySyntaxArgs(rawArgs);
    const out = await verifySyntax(files, ctx.workingDir);
    return {
      tool: VERIFY_SYNTAX_TOOL,
      status: out.failed > 0 ? "error" : "ok",
      summary: out.summary,
      details: {
        results: out.results,
        passed: out.passed,
        failed: out.failed,
        unchecked: out.unchecked,
      },
      truncated: out.summary.endsWith("[clipped]"),
    };
  },
};
