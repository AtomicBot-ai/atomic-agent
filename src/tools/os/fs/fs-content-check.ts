/**
 * Write-time feedback on what a model just put in a file, beyond the
 * parse check in `fs-parse-check.ts` — and the one place the three
 * mutating tools ask for both.
 *
 * Seen in the field, each costing a later step to find:
 *  - an `index.html` carrying 16,627 bytes after `</html>`, serialized
 *    tool-call text included, and an inline `<script>` that did not
 *    parse (the parse check only knew `.js`);
 *  - a `game.js` with 36 literal `\n` sequences and no real newlines —
 *    the model escaped its content twice;
 *  - atag's own transcript markup (`assistant_tool_call:`,
 *    `tool_result[`) written into a file as if it were content.
 *
 * Same contract as the parse check: warn only, never block, never alter
 * the write; a heuristic that can misfire (a fixture that quotes the
 * markup, a regex source full of `\n`) stays a warning the model may
 * read and ignore.
 */
import { extname } from "node:path";
import {
  checkFileParses,
  displayPath,
  formatParseWarning,
  isParseCheckedPath,
  PARSE_CHECK_MAX_CHARS,
} from "./fs-parse-check.js";

export type ContentWarningKind =
  | "html_script"
  | "html_trailing"
  | "transcript_markup"
  | "double_escaped";

export interface ContentWarning {
  readonly kind: ContentWarningKind;
  /** Distinguishes warnings of one kind (which script block, which marker). */
  readonly key: string;
  /** Grows with the problem; an edit that made it worse is reported again. */
  readonly count: number;
  /** The sentence after `⚠ <path>: `. */
  readonly message: string;
}

const HTML_EXTENSIONS = new Set([".html", ".htm"]);

/**
 * Literal `\n` sequences below this never count as double-escaping: a
 * one-line JSON string or a regex source legitimately holds a few.
 */
export const DOUBLE_ESCAPE_MIN_LITERALS = 4;

/** atag's transcript syntax, which has no business at the start of a file line. */
const TRANSCRIPT_MARKERS = [
  "assistant_tool_call:",
  "tool_result[",
  "<|channel|>",
  "<|turn>",
] as const;

const TRANSCRIPT_MARKUP_LINE = /^(assistant_tool_call:|tool_result\[|<\|channel\|>|<\|turn>)/gm;

/** Every warning `content` earns as the file at `path`. Never throws. */
export function checkWrittenContent(
  path: string,
  content: string,
): ContentWarning[] {
  if (content.length > PARSE_CHECK_MAX_CHARS) return [];
  try {
    const warnings: ContentWarning[] = [];
    if (HTML_EXTENSIONS.has(extname(path).toLowerCase())) {
      warnings.push(...checkHtml(path, content));
    }
    const markup = checkTranscriptMarkup(content);
    if (markup !== null) warnings.push(markup);
    const escaped = checkDoubleEscaped(content);
    if (escaped !== null) warnings.push(escaped);
    return warnings;
  } catch {
    return [];
  }
}

const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const CLASSIC_SCRIPT_TYPE =
  /^(?:text|application)\/(?:x-)?(?:javascript|ecmascript)$|^$/i;

function checkHtml(path: string, content: string): ContentWarning[] {
  const warnings: ContentWarning[] = [];
  let index = 0;
  for (const match of content.matchAll(SCRIPT_BLOCK)) {
    index += 1;
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]*)/i.exec(attrs)?.[1] ?? "";
    // `module` scripts are ES modules, which a plain script parse cannot
    // judge; JSON, templates and import maps are not scripts at all.
    if (!CLASSIC_SCRIPT_TYPE.test(type)) continue;
    const startLine = lineOf(content, match.index ?? 0);
    // Padding with the lines above the block makes the parser report
    // the line as it is in the file, not inside the block.
    const check = checkFileParses(
      `${path}.script${index}.js`,
      "\n".repeat(startLine - 1) + body,
    );
    if (check.kind !== "error") continue;
    warnings.push({
      kind: "html_script",
      key: `script${index}`,
      count: 1,
      message: `inline <script> #${index} does not parse: ${check.message}`,
    });
  }
  const close = content.search(/<\/html\s*>/i);
  if (close !== -1) {
    const end = content.indexOf(">", close) + 1;
    const trailing = content.slice(end);
    if (trailing.trim().length > 0) {
      warnings.push({
        kind: "html_trailing",
        key: "trailing",
        count: trailing.length,
        message:
          `${trailing.length} chars of content after </html> (from line ${lineOf(content, end)}) — ` +
          "nothing belongs after the closing tag; remove it",
      });
    }
  }
  return warnings;
}

function checkTranscriptMarkup(content: string): ContentWarning | null {
  const hits = Array.from(content.matchAll(TRANSCRIPT_MARKUP_LINE));
  const first = hits[0];
  if (first === undefined) return null;
  const marker =
    TRANSCRIPT_MARKERS.find((m) => first[0].startsWith(m)) ?? first[0];
  const line = lineOf(content, first.index ?? 0);
  const more = hits.length > 1 ? ` and ${hits.length - 1} more line(s)` : "";
  return {
    kind: "transcript_markup",
    key: marker,
    count: hits.length,
    message:
      `line ${line}${more} starts with \`${marker}\` — that is agent transcript markup, ` +
      "not file content; remove it",
  };
}

function checkDoubleEscaped(content: string): ContentWarning | null {
  const literal = (content.match(/(?<!\\)\\n/g) ?? []).length;
  if (literal < DOUBLE_ESCAPE_MIN_LITERALS) return null;
  const real = (content.match(/\n/g) ?? []).length;
  if (literal <= real) return null;
  return {
    kind: "double_escaped",
    key: "newlines",
    count: literal,
    message:
      `${literal} literal \\n sequences but ${real} real newline(s) — ` +
      "the content looks escaped twice; write it with real newlines",
  };
}

/** 1-based line of `offset` in `content`. */
function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * The warnings a change introduced: everything `after` earns that
 * `before` did not, plus anything that grew. A problem the file already
 * had, and the change left alone, was reported when it was written.
 */
export function newContentWarnings(
  path: string,
  before: string | undefined,
  after: string,
): ContentWarning[] {
  const now = checkWrittenContent(path, after);
  if (before === undefined || now.length === 0) return now;
  const earlier = new Map(
    checkWrittenContent(path, before).map((w) => [`${w.kind}:${w.key}`, w]),
  );
  return now.filter((w) => {
    const prior = earlier.get(`${w.kind}:${w.key}`);
    return prior === undefined || w.count > prior.count;
  });
}

export interface ChangedFileCheckInput {
  readonly absolute: string;
  readonly workingDir: string;
  readonly change: "write" | "edit" | "patch";
  /** The file before the change; omitted when unknown or brand new. */
  readonly before?: string;
  /** The file after the change. */
  readonly after: string;
  /** `os.fs.edit` only: how many occurrences the edit replaced. */
  readonly replacedOccurrences?: number;
}

/**
 * Everything the tool result should say about the changed file: the
 * parse warning first (see `formatParseWarning`), then one `⚠` line per
 * content warning. `null` when there is nothing to say.
 */
export function checkChangedFile(input: ChangedFileCheckInput): string | null {
  const path = displayPath(input.absolute, input.workingDir);
  const lines: string[] = [];
  if (isParseCheckedPath(input.absolute)) {
    const parse = formatParseWarning({
      path,
      change: input.change,
      after: checkFileParses(input.absolute, input.after),
      ...(input.before !== undefined
        ? { before: checkFileParses(input.absolute, input.before) }
        : {}),
      ...(input.replacedOccurrences !== undefined
        ? { replacedOccurrences: input.replacedOccurrences }
        : {}),
    });
    if (parse !== null) lines.push(parse);
  }
  const content =
    input.change === "write"
      ? checkWrittenContent(input.absolute, input.after)
      : newContentWarnings(input.absolute, input.before, input.after);
  for (const warning of content) lines.push(`⚠ ${path}: ${warning.message}`);
  return lines.length > 0 ? lines.join("\n") : null;
}
