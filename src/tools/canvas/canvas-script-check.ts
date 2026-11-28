import { Script } from "node:vm";

/**
 * ATO-2457: check the script of a page `canvas.render` is about to save,
 * before anyone sees it. A page whose script does not parse draws as a
 * blank or half-built card, and the model never learns why; here the call
 * fails with the line and the parser's message, so the model fixes it on
 * the next step (Claude artifacts' "Try fixing", Cursor's lint-after-edit).
 *
 * Only parsing: `new vm.Script` compiles the text and runs nothing. Checked
 * are the inline classic scripts (no `type`, or a JavaScript one); a module
 * script (`import` is not classic syntax), JSON, templates and other types
 * are left alone. A `<script src>` is reported too: the chat runs a page
 * with no network (desktop/main/artifact-frame.ts), so a library from a CDN
 * never loads and the page breaks the same way.
 */

export interface ScriptProblem {
  /** 1-based: which `<script>` of the page. */
  script: number;
  /** 1-based line in the page as the model wrote it; 0 when unknown. */
  line: number;
  message: string;
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const JS_TYPES = /^(?:|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|text\/jscript)$/i;
/** At most this many problems are reported; the model fixes them and calls again. */
export const SCRIPT_PROBLEMS_MAX = 3;

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, "i").test(attrs) ? "" : undefined;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** The line V8 names in a SyntaxError's stack (`script-2.js:5`), or 0. */
function errorLine(err: unknown, filename: string): number {
  const stack = err instanceof Error && typeof err.stack === "string" ? err.stack : "";
  const m = new RegExp(`${filename.replace(/[.]/g, "\\.")}:(\\d+)`).exec(stack);
  return m ? Number(m[1]) : 0;
}

/** The first problems with the page's scripts; empty when every one parses. */
export function checkPageScripts(html: string): ScriptProblem[] {
  const problems: ScriptProblem[] = [];
  let n = 0;
  for (const m of html.matchAll(SCRIPT_RE)) {
    n++;
    if (problems.length >= SCRIPT_PROBLEMS_MAX) break;
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    const start = (m.index ?? 0) + m[0].indexOf(">") + 1;
    const src = attr(attrs, "src");
    if (src !== undefined) {
      problems.push({
        script: n,
        line: lineAt(html, m.index ?? 0),
        message: `loads ${src.slice(0, 120) || "a file"}, but the page runs with no network, so it never loads; put the code inline (or use \`chart\` for a chart)`,
      });
      continue;
    }
    const type = (attr(attrs, "type") ?? "").trim();
    if (!JS_TYPES.test(type) || !body.trim()) continue;
    const filename = `script-${n}.js`;
    try {
      new Script(body, { filename });
    } catch (err) {
      const inScript = errorLine(err, filename);
      problems.push({
        script: n,
        line: inScript > 0 ? lineAt(html, start) + inScript - 1 : 0,
        message: `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`.slice(0, 300),
      });
    }
  }
  return problems;
}

/** The tool's error text for the problems: one line each, then what to do. */
export function scriptProblemsText(problems: readonly ScriptProblem[]): string {
  const lines = problems.map((p) => `- script ${p.script}${p.line > 0 ? ` (page line ${p.line})` : ""}: ${p.message}`);
  return [
    `the page's script has ${problems.length === 1 ? "a problem" : "problems"}, so nothing was saved:`,
    ...lines,
    "Fix the script and call canvas.render again with the whole page.",
  ].join("\n");
}
