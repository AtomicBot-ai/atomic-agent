/**
 * HTML: every inline `<script>` block goes through the JavaScript
 * checker, and content after `</html>` is called out.
 *
 * Both come from the same failure: a model that appends to a page
 * instead of editing it. The second `<script>` it adds is where the
 * unclosed brace lives, and the text it leaves after `</html>` — a
 * duplicate of the page, a stray fence, a note to itself — is parsed by
 * the browser as more body, silently.
 *
 * No HTML validation beyond that: browsers repair markup, so a lint on
 * tag balance would fail pages that render perfectly.
 */
import { checkJavaScriptSource } from "./check-script-syntax.js";
import type { SyntaxFileResult } from "./syntax-check-types.js";

export const HTML_CHECKER = "html-inline-js";

const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SRC_ATTR = /\bsrc\s*=/i;
const TYPE_ATTR = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const JS_TYPES = new Set([
  "",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
  "module",
]);

interface InlineScript {
  readonly index: number;
  readonly line: number;
  readonly code: string;
  readonly module: boolean;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/** Inline JavaScript blocks, in document order; external and non-JS blocks skipped. */
export function extractInlineScripts(html: string): {
  scripts: InlineScript[];
  external: number;
} {
  const scripts: InlineScript[] = [];
  let external = 0;
  let index = 0;
  for (const match of html.matchAll(SCRIPT_BLOCK)) {
    const attrs = match[1] ?? "";
    const code = match[2] ?? "";
    index += 1;
    if (SRC_ATTR.test(attrs)) {
      external += 1;
      continue;
    }
    const typeMatch = attrs.match(TYPE_ATTR);
    const type = (typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3] ?? "")
      .trim()
      .toLowerCase();
    if (!JS_TYPES.has(type)) continue;
    const bodyOffset = (match.index ?? 0) + match[0].indexOf(code, attrs.length);
    scripts.push({
      index,
      line: lineOf(html, bodyOffset),
      code,
      module: type === "module",
    });
  }
  return { scripts, external };
}

/** Non-whitespace after the last `</html>`, or `null`. */
export function trailingContentWarning(html: string): string | null {
  const close = html.toLowerCase().lastIndexOf("</html>");
  if (close === -1) return null;
  const rest = html.slice(close + "</html>".length);
  if (rest.trim().length === 0) return null;
  const head = rest.trim().replace(/\s+/g, " ").slice(0, 80);
  return `${rest.trim().length} chars of content after </html> (browsers render it as more body): "${head}"`;
}

/** Rebase a `(line N)` relative to the block onto the document. */
function rebaseLine(message: string, blockLine: number): string {
  return message.replace(
    /\(line (\d+)\)$/,
    (_m, n: string) => `(line ${blockLine + Number.parseInt(n, 10) - 1})`,
  );
}

export async function checkHtmlSource(
  file: string,
  html: string,
): Promise<SyntaxFileResult> {
  const { scripts, external } = extractInlineScripts(html);
  const warning = trailingContentWarning(html);
  const withWarning = (
    result: SyntaxFileResult,
  ): SyntaxFileResult => (warning === null ? result : { ...result, warning });

  if (scripts.length === 0) {
    const externals = external > 0 ? ` (${external} external)` : "";
    return withWarning({
      file,
      ok: null,
      checker: HTML_CHECKER,
      error: `no inline scripts to check${externals}`,
    });
  }
  const failures: string[] = [];
  const unjudged: string[] = [];
  for (const script of scripts) {
    const verdict = await checkJavaScriptSource(
      `${file}#script${script.index}`,
      script.code,
      { module: script.module },
    );
    const label = `inline script #${script.index} (line ${script.line})`;
    if (verdict.ok === false) {
      failures.push(`${label}: ${rebaseLine(verdict.error ?? "syntax error", script.line)}`);
    } else if (verdict.ok === null) {
      unjudged.push(`${label}: ${verdict.error ?? "no verdict"}`);
    }
  }
  if (failures.length > 0) {
    return withWarning({
      file,
      ok: false,
      checker: HTML_CHECKER,
      error: failures.join("; "),
    });
  }
  if (unjudged.length > 0) {
    return withWarning({
      file,
      ok: null,
      checker: HTML_CHECKER,
      error: unjudged.join("; "),
    });
  }
  return withWarning({ file, ok: true, checker: HTML_CHECKER });
}
