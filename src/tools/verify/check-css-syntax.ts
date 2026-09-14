/**
 * CSS: brace balance, outside strings and comments.
 *
 * Not a CSS parser — a stray `}` or an unclosed rule is what a model
 * leaves behind when an edit cuts a block in half, and that is what this
 * catches. Property typos and unknown selectors are the browser's to
 * ignore, not ours to flag.
 */
import type { SyntaxFileResult } from "./syntax-check-types.js";

export const CSS_CHECKER = "css-braces";

export function checkCssSource(
  file: string,
  content: string,
): SyntaxFileResult {
  let depth = 0;
  let line = 1;
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === "\n") {
      line += 1;
      i += 1;
    } else if (ch === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      line += countNewlines(content, i, stop);
      i = stop;
    } else if (ch === '"' || ch === "'") {
      const stop = skipString(content, i, ch);
      line += countNewlines(content, i, stop);
      i = stop;
    } else if (ch === "{") {
      depth += 1;
      i += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth < 0) {
        return {
          file,
          ok: false,
          checker: CSS_CHECKER,
          error: `unexpected \`}\` at line ${line} (no open block)`,
        };
      }
      i += 1;
    } else {
      i += 1;
    }
  }
  if (depth > 0) {
    return {
      file,
      ok: false,
      checker: CSS_CHECKER,
      error: `${depth} unclosed \`{\` at end of file`,
    };
  }
  return { file, ok: true, checker: CSS_CHECKER };
}

function skipString(text: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    // An unescaped newline ends a CSS string (it is invalid, but the
    // brace count must not run away because of it).
    if (ch === quote || ch === "\n") return i + 1;
    i += 1;
  }
  return text.length;
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i += 1) if (text[i] === "\n") count += 1;
  return count;
}
