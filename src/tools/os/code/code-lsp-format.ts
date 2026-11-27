/**
 * The compact answer of `os.code.lsp` (ATO-2373): one line per hit,
 * `path:line:col: <that line of code>` like `os.code.search`, a capped
 * count, and a clipped hover. No file bodies, no raw LSP JSON.
 */
import type { LspHit, LspNavAction, LspNavAnswer } from "../fs/lsp/lsp-navigation.js";

/** One printed code line is clipped to this many characters. */
export const LSP_LINE_CLIP = 200;
/** Hover text beyond this many characters (or lines) is cut. */
export const LSP_HOVER_MAX_CHARS = 2000;
export const LSP_HOVER_MAX_LINES = 40;

export interface LspFormatOptions {
  readonly action: LspNavAction;
  /** `src/a.ts:12:5`, the position asked about (or the file for symbols). */
  readonly target: string;
  /** `query` of a workspace symbol search. */
  readonly query?: string;
  readonly maxResults: number;
  /** The path as the model reads it. */
  displayPath(absolute: string): string;
  /** Line `line` (1-based) of `absolute`, or null when it may not be shown. */
  lineOf(absolute: string, line: number): string | null;
}

export interface LspFormatted {
  readonly text: string;
  readonly total: number;
  readonly shown: number;
}

const NOTHING_HINT =
  "A server that has just started may still be indexing the project; try again in a moment.";

export function clipLine(line: string): string {
  const flat = line.trim();
  return flat.length > LSP_LINE_CLIP ? `${flat.slice(0, LSP_LINE_CLIP - 3)}...` : flat;
}

export function formatLspAnswer(answer: LspNavAnswer, options: LspFormatOptions): LspFormatted {
  if (answer.kind === "hover") return formatHover(answer.text, options.target);
  const hits = dedupe(answer.hits);
  const shown = hits.slice(0, options.maxResults);
  if (hits.length === 0) {
    return { text: `${emptyHeader(options)}\n${NOTHING_HINT}`, total: 0, shown: 0 };
  }
  const more =
    shown.length < hits.length
      ? ` (first ${shown.length} shown; raise maxResults to see more)`
      : "";
  const lines = [`${header(options, hits)}${more}`];
  for (const h of shown) lines.push(formatHit(h, options));
  return { text: lines.join("\n"), total: hits.length, shown: shown.length };
}

function formatHover(text: string | null, target: string): LspFormatted {
  if (text === null) {
    return { text: `no hover information at ${target}.\n${NOTHING_HINT}`, total: 0, shown: 0 };
  }
  let body = text;
  let cut = false;
  const rows = body.split(/\r?\n/);
  if (rows.length > LSP_HOVER_MAX_LINES) {
    body = rows.slice(0, LSP_HOVER_MAX_LINES).join("\n");
    cut = true;
  }
  if (body.length > LSP_HOVER_MAX_CHARS) {
    body = body.slice(0, LSP_HOVER_MAX_CHARS);
    cut = true;
  }
  return {
    text: `hover at ${target}:\n${body}${cut ? "\n... (cut)" : ""}`,
    total: 1,
    shown: 1,
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function header(options: LspFormatOptions, hits: readonly LspHit[]): string {
  const files = new Set(hits.map((h) => h.path ?? h.uri)).size;
  switch (options.action) {
    case "definition":
      return `${plural(hits.length, "definition", "definitions")} of ${options.target}`;
    case "references":
      return `${plural(hits.length, "reference", "references")} to ${options.target} in ${plural(files, "file", "files")}`;
    default:
      return options.query !== undefined
        ? `${plural(hits.length, "symbol", "symbols")} matching "${options.query}" in ${plural(files, "file", "files")}`
        : `${plural(hits.length, "symbol", "symbols")} in ${options.target}`;
  }
}

function emptyHeader(options: LspFormatOptions): string {
  switch (options.action) {
    case "definition":
      return `no definition found for ${options.target}.`;
    case "references":
      return `no references found for ${options.target}.`;
    default:
      return options.query !== undefined
        ? `no symbols matching "${options.query}".`
        : `no symbols in ${options.target}.`;
  }
}

function formatHit(h: LspHit, options: LspFormatOptions): string {
  const where = h.path === null ? h.uri : options.displayPath(h.path);
  if (h.line === 0) return `${where}: ${h.label ?? ""}`.trimEnd();
  if (h.label !== undefined) {
    // Symbols: name and kind say more than the line they start on.
    const indent = "  ".repeat(h.depth ?? 0);
    return `${indent}${where}:${h.line}: ${h.label}`;
  }
  const code = h.path === null ? null : options.lineOf(h.path, h.line);
  const position = `${where}:${h.line}:${h.col}`;
  return code === null || code.length === 0 ? position : `${position}: ${clipLine(code)}`;
}

/** Servers sometimes list one place twice (a declaration that is also a definition). */
function dedupe(hits: readonly LspHit[]): LspHit[] {
  const seen = new Set<string>();
  const out: LspHit[] = [];
  for (const h of hits) {
    const key = `${h.uri}\u0000${h.line}\u0000${h.col}\u0000${h.label ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}
