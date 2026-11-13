import { relative, isAbsolute } from "node:path";
import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { AST_GREP_MISSING_HINT } from "./ast-grep-resolver.js";
import {
  astGrepDependencies,
  parseAstGrepQuery,
  runAstGrep,
  type AstGrepDependencies,
} from "./ast-grep-run.js";
import type { AstGrepMatch } from "./ast-grep-json.js";
import { OS_CODE_SEARCH_CONTRACT } from "./code-search-contract.js";

const TOOL = OS_CODE_SEARCH_CONTRACT.name;
export const CODE_SEARCH_DEFAULT_RESULTS = 100;
export const CODE_SEARCH_MAX_RESULTS = 1_000;
/** One printed match line is clipped to this many characters. */
const LINE_CLIP = 200;

export function buildOsCodeSearchTool(
  deps: Partial<AstGrepDependencies> = {},
): ToolDefinition {
  const resolved = astGrepDependencies(deps);
  return {
    name: TOOL,
    description: OS_CODE_SEARCH_CONTRACT.description,
    readonly: OS_CODE_SEARCH_CONTRACT.readonly,
    async run(rawArgs, ctx) {
      const query = parseAstGrepQuery(rawArgs, TOOL, false);
      const maxResults = parseMaxResults(rawArgs.maxResults);
      const binary = resolved.resolveAstGrepPath();
      if (binary === null) {
        return compressToolResult({
          tool: TOOL,
          status: "error",
          output: AST_GREP_MISSING_HINT,
          details: { missing: true, hint: AST_GREP_MISSING_HINT },
        });
      }
      const outcome = await runAstGrep(query, binary, resolved, ctx, 4 * 1024 * 1024);
      if (outcome.kind === "error") {
        return compressToolResult({
          tool: TOOL,
          status: "error",
          output: outcome.message,
          details: outcome.details,
        });
      }
      const { matches, result, command } = outcome;
      const shown = matches.slice(0, maxResults);
      const files = new Set(matches.map((m) => m.file));
      const truncated = matches.length > shown.length || result.truncated || result.timedOut;
      const lines: string[] = [];
      if (result.timedOut) {
        lines.push(
          `note: ast-grep stopped after ${query.timeoutMs} ms; these are the matches found so far. Narrow \`path\` or \`globs\`.`,
        );
      } else if (result.truncated) {
        lines.push("note: the output was cut off; narrow `path` or `globs` to see every match.");
      }
      if (matches.length === 0) {
        lines.push("(no matches)");
      } else {
        lines.push(
          `${matches.length} match${matches.length === 1 ? "" : "es"} in ${files.size} file${files.size === 1 ? "" : "s"}` +
            (shown.length < matches.length ? ` (first ${shown.length} shown; raise maxResults or narrow path)` : ""),
        );
        for (const m of shown) lines.push(formatMatch(m, ctx.workingDir));
      }
      return compressToolResult(
        {
          tool: TOOL,
          status: "ok",
          output: lines.join("\n"),
          details: {
            totals: { files: files.size, matches: matches.length },
            matches: shown.map((m) => ({
              file: displayPath(m.file, ctx.workingDir),
              line: m.line,
              column: m.column,
              endLine: m.endLine,
              text: m.text,
            })),
            truncated,
            command,
            ...(query.path !== undefined ? { path: query.path } : {}),
          },
        },
        { maxSummaryLength: 32 * 1024, maxTailLines: 1000 },
      );
    },
  };
}

function parseMaxResults(raw: unknown): number {
  if (raw === undefined || raw === null) return CODE_SEARCH_DEFAULT_RESULTS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) {
    throw new Error(`${TOOL}: \`maxResults\` must be a positive number`);
  }
  return Math.min(Math.floor(raw), CODE_SEARCH_MAX_RESULTS);
}

/** `src/a.ts:12:5: <first line of the match's source>` */
function formatMatch(m: AstGrepMatch, workingDir: string): string {
  const first = (m.lines.split(/\r?\n/)[0] ?? "").trim();
  const clipped = first.length > LINE_CLIP ? `${first.slice(0, LINE_CLIP - 3)}...` : first;
  const span = m.endLine > m.line ? ` (to line ${m.endLine})` : "";
  return `${displayPath(m.file, workingDir)}:${m.line}:${m.column}: ${clipped}${span}`;
}

/** Relative to the working directory when inside it, absolute otherwise. */
export function displayPath(file: string, workingDir: string): string {
  if (!isAbsolute(file)) return file;
  const rel = relative(workingDir, file);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file;
}
