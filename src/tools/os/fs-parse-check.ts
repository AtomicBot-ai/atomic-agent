/**
 * Parse-check for the code files `os.fs.write` / `os.fs.edit` /
 * `os.fs.patch` just changed.
 *
 * A local model once wrote four JS files that each ended on an unclosed
 * object literal (`HD.X = { …methods… },` at EOF) and only found out
 * about half an hour later, when it finally ran `node --check`. Every
 * step in between built on broken files. It then "fixed" one with a
 * blind `replaceAll` of `},\n` → `};\n`, which broke every method
 * separator and still missed the real culprit. Checking in-process,
 * right after the change, puts the syntax error into the very tool
 * result that caused it.
 *
 * The check is advisory and deliberately conservative:
 *  - it never blocks, fails or alters a write — it only adds a warning;
 *  - it never warns about a file that parses;
 *  - when plain `vm.Script` parsing cannot give a trustworthy verdict
 *    (ES modules, JSX, Flow, decorators) it says nothing at all rather
 *    than raise a false alarm. Node offers no flag-free way to parse an
 *    ES module without evaluating it, so module files are skipped.
 */
import vm from "node:vm";
import { basename, extname, isAbsolute, relative, sep } from "node:path";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";

export type ParseCheck =
  | { readonly kind: "ok" }
  | { readonly kind: "skipped" }
  | { readonly kind: "error"; readonly message: string };

const OK: ParseCheck = { kind: "ok" };
const SKIPPED: ParseCheck = { kind: "skipped" };

/** Above this the check is skipped: generated bundles, data dumps. */
export const PARSE_CHECK_MAX_CHARS = 2 * 1024 * 1024;

/**
 * "More than a few" replaced occurrences: past this, an edit that leaves
 * the file unparseable reads as a blind search-and-replace, and the
 * warning says so.
 */
export const MANY_OCCURRENCES = 3;

const CHECKED_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".json"]);

/** Files consumed by strict JSON parsers (npm) — no JSONC leniency. */
const STRICT_JSON_FILES = new Set(["package.json", "package-lock.json"]);

/** The wrapper Node puts around a CommonJS file. */
const CJS_WRAPPER_PARAMS = [
  "exports",
  "require",
  "module",
  "__filename",
  "__dirname",
];

/**
 * V8's script-parse errors for syntax that is only legal in an ES
 * module. Any of these as the first error means the file is (or is
 * meant to be) a module, which this check cannot parse.
 */
const MODULE_ONLY_ERRORS = new Set([
  "Cannot use import statement outside a module",
  "Unexpected token 'export'",
  "Cannot use 'import.meta' outside a module",
  "await is only valid in async functions and the top level bodies of modules",
]);

/** Static `import …` / `export …` at a line start, or `import.meta`. */
const MODULE_SYNTAX =
  /^[ \t]*(?:import(?:\s+[\w$]|\s*[{*"'])|export(?:\s+[\w$]|\s*[{*]))|\bimport\.meta\b/m;

/** True when `path` has an extension this module knows how to check. */
export function isParseCheckedPath(path: string): boolean {
  return CHECKED_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * Parse `content` as the file at `path` would be parsed. `skipped` means
 * "no verdict" — an unchecked extension, an oversized file, or syntax
 * plain script parsing cannot judge. Never throws.
 */
export function checkFileParses(path: string, content: string): ParseCheck {
  const ext = extname(path).toLowerCase();
  if (!CHECKED_EXTENSIONS.has(ext)) return SKIPPED;
  if (content.length > PARSE_CHECK_MAX_CHARS) return SKIPPED;
  const source = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const name = basename(path);
  try {
    return ext === ".json"
      ? checkJson(name, source)
      : checkScript(name, source, ext);
  } catch {
    // A check that blew up (a pathologically nested file overflowing the
    // parser's stack, say) is no verdict, and must never reach the write.
    return SKIPPED;
  }
}

function checkJson(name: string, source: string): ParseCheck {
  try {
    JSON.parse(source);
    return OK;
  } catch (err) {
    if (!STRICT_JSON_FILES.has(name.toLowerCase())) {
      // tsconfig.json, .vscode/settings.json, devcontainer.json and
      // friends are JSONC: comments and trailing commas are legal there.
      try {
        JSON.parse(stripJsonc(source));
        return OK;
      } catch {
        // Broken even under JSONC rules — report the strict error.
      }
    }
    return { kind: "error", message: `SyntaxError: ${messageOf(err)}` };
  }
}

function checkScript(name: string, source: string, ext: string): ParseCheck {
  // Compiling does not run anything: `vm.Script` only parses.
  let error = compileError(() => new vm.Script(source, { filename: name }));
  if (error === null) return OK;
  if (error.message === "Illegal return statement") {
    // Node wraps a CommonJS file in a function, so a top-level `return`
    // is legal there. Compile it the way Node would load it.
    error = compileError(() =>
      vm.compileFunction(source, CJS_WRAPPER_PARAMS, { filename: name }),
    );
    if (error === null) return OK;
  }
  if (beyondPlainScript(name, source, ext, error)) return SKIPPED;
  const line = errorLine(error, name);
  return {
    kind: "error",
    message: `SyntaxError: ${error.message}${line === null ? "" : ` (line ${line})`}`,
  };
}

/**
 * Whether the parse failure may come from syntax that is valid for the
 * file's real consumer but not for a plain script parse — in which case
 * the failure is no evidence the file is broken.
 */
function beyondPlainScript(
  name: string,
  source: string,
  ext: string,
  error: Error,
): boolean {
  if (ext === ".mjs") return true;
  if (MODULE_ONLY_ERRORS.has(error.message)) return true;
  if (MODULE_SYNTAX.test(source)) return true;
  // Top-level `for await` / `await using` — module-only as well.
  if (/^[ \t]*(?:for\s+await\b|await\s+using\b)/m.test(source)) return true;
  // JSX: `<div>` is where a plain parser gives up.
  if (error.message === "Unexpected token '<'") return true;
  // Flow declares itself in the header comment; its types are not JS.
  if (/@flow\b/.test(source.slice(0, 2048))) return true;
  // Decorators (transpiler-only): the error lands on the `@` line.
  if (/^\s*@/.test(errorSourceLine(error, name) ?? "")) return true;
  return false;
}

function compileError(compile: () => unknown): Error | null {
  try {
    compile();
    return null;
  } catch (err) {
    if (err instanceof Error && err.name === "SyntaxError") return err;
    throw err;
  }
}

/**
 * V8 carries no line property on a SyntaxError; Node decorates the stack
 * instead: `<filename>:<line>`, then the offending source line, then a
 * caret. Absent that decoration the line is simply left out.
 */
function stackLines(error: Error, name: string): string[] | null {
  if (typeof error.stack !== "string") return null;
  const lines = error.stack.split("\n");
  return lines[0]?.startsWith(`${name}:`) ? lines : null;
}

function errorLine(error: Error, name: string): number | null {
  const first = stackLines(error, name)?.[0];
  if (first === undefined) return null;
  const line = Number.parseInt(first.slice(name.length + 1), 10);
  return Number.isInteger(line) && line > 0 ? line : null;
}

function errorSourceLine(error: Error, name: string): string | null {
  return stackLines(error, name)?.[1] ?? null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Drop `//` and block comments and trailing commas outside strings, so
 * a JSONC file can be judged by `JSON.parse`.
 */
function stripJsonc(source: string): string {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '"') {
      i += 1;
      while (i < n && source[i] !== '"') i += source[i] === "\\" ? 2 : 1;
      i += 1;
    } else if (ch === "/" && source[i + 1] === "/") {
      parts.push(source.slice(start, i));
      while (i < n && source[i] !== "\n") i += 1;
      start = i;
    } else if (ch === "/" && source[i + 1] === "*") {
      parts.push(source.slice(start, i));
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      start = i;
    } else {
      i += 1;
    }
  }
  parts.push(source.slice(start));
  return parts
    .join("")
    .replace(
      /("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g,
      (match, str: string | undefined, close: string | undefined) =>
        str ?? close ?? match,
    );
}

/** The path as the model should read it: relative inside the workspace. */
export function displayPath(absolute: string, workingDir: string): string {
  const rel = relative(workingDir, absolute);
  if (
    rel.length === 0 ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return absolute;
  }
  return rel;
}

export interface ParseWarningInput {
  /** The path as shown to the model (see `displayPath`). */
  readonly path: string;
  readonly change: "write" | "edit" | "patch";
  /** The file after the change. */
  readonly after: ParseCheck;
  /** The file before the change; omitted when unknown or brand new. */
  readonly before?: ParseCheck;
  /** `os.fs.edit` only: how many occurrences the edit replaced. */
  readonly replacedOccurrences?: number;
}

/**
 * The warning line for the tool result, or null when there is nothing to
 * say (the file parses, or no verdict was possible).
 */
export function formatParseWarning(input: ParseWarningInput): string | null {
  const { after, before, change, path } = input;
  if (after.kind !== "error") return null;
  const count = input.replacedOccurrences;
  const occurrences =
    count === undefined ? "" : `${count} occurrence${count === 1 ? "" : "s"}`;
  if (change !== "write" && before?.kind === "ok") {
    // This change broke a file that was fine: say so, with the count, so
    // the model undoes it instead of stacking a fix on top of the break.
    return (
      `⚠ ${path} does not parse after this ${change}: ${after.message}. ` +
      `It parsed before the ${change}` +
      (occurrences.length > 0 ? `, which replaced ${occurrences}` : "") +
      ` — undo it, or re-read the file and rewrite it, instead of stacking more edits.`
    );
  }
  if (before?.kind === "error") {
    if (count !== undefined && count > MANY_OCCURRENCES) {
      return (
        `⚠ ${path} still does not parse: ${after.message}. ` +
        `This ${change} replaced ${occurrences} without fixing it (before it: ${before.message})` +
        ` — re-read the file and fix that error instead of stacking more edits.`
      );
    }
    return before.message === after.message
      ? `⚠ ${path} still does not parse: ${after.message}`
      : `⚠ ${path} still does not parse: ${after.message} (before this ${change}: ${before.message})`;
  }
  return count !== undefined && count > MANY_OCCURRENCES
    ? `⚠ ${path} does not parse: ${after.message}. This ${change} replaced ${occurrences}.`
    : `⚠ ${path} does not parse: ${after.message}`;
}

/**
 * Put `warning` in front of what the model reads. Prepended rather than
 * appended to the output: the result compressor keeps the *tail* of the
 * output, but both the summary length cap and the per-batch cap keep the
 * *head* of the summary — the warning has to survive all three.
 */
export function withParseWarning(
  result: CompressedToolResult,
  warning: string | null,
): CompressedToolResult {
  if (warning === null || warning.length === 0) return result;
  return {
    ...result,
    summary:
      result.summary.length > 0 ? `${warning}\n${result.summary}` : warning,
    details: { ...result.details, parseWarning: warning },
  };
}
