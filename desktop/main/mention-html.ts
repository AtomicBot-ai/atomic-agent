/**
 * ATO-2241: the words of an HTML page for an `@https://...` mention.
 * One left-to-right scan with indexOf, so the time is linear in the page
 * size whatever the markup: lazy regexes over `<!--` or an unclosed
 * `<script` are quadratic and would freeze the main process on a 512 KB
 * page. A comment, raw-text block or tag with no end drops the rest of
 * the page.
 */

/** Elements whose content is not words: skipped up to their closing tag. */
const RAW_TEXT: ReadonlySet<string> = new Set(["script", "style", "noscript", "svg", "head", "template", "textarea"]);

/** Tags that end a line of text (closing tags, plus `<br>`). */
const LINE_ENDS: ReadonlySet<string> = new Set([
  "br", "/p", "/div", "/li", "/h1", "/h2", "/h3", "/h4", "/h5", "/h6", "/tr", "/pre", "/section", "/article",
]);

const TAG_NAME = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]{0,31})/;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

/** Index of the closing `</name` at or after `from` (any case), or -1. */
function closingTag(html: string, name: string, from: number): number {
  const re = new RegExp(`</${name}(?![a-zA-Z0-9-])`, "gi");
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index : -1;
}

/** The page with comments, raw-text blocks and tags taken out; tags become spaces or line ends. */
export function stripMarkup(html: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      parts.push(html.slice(i));
      break;
    }
    parts.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) break;
      parts.push(" ");
      i = end + 3;
      continue;
    }
    const next = html.charAt(lt + 1);
    const m = /[a-zA-Z/]/.test(next) ? TAG_NAME.exec(html.slice(lt, lt + 40)) : null;
    if (!m && next !== "!" && next !== "?") {
      // A bare `<` in the text (`a < b`): it stays.
      parts.push("<");
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break;
    const closing = m?.[1] === "/";
    const name = (m?.[2] ?? "").toLowerCase();
    if (m && !closing && RAW_TEXT.has(name)) {
      const close = closingTag(html, name, gt + 1);
      if (close < 0) break;
      const closeEnd = html.indexOf(">", close);
      if (closeEnd < 0) break;
      parts.push(" ");
      i = closeEnd + 1;
      continue;
    }
    parts.push(LINE_ENDS.has(closing ? `/${name}` : name) ? "\n" : " ");
    i = gt + 1;
  }
  return parts.join("");
}

/** The words of an HTML page: scripts, styles and tags out, block ends as line breaks. */
export function htmlToText(html: string): string {
  return stripMarkup(html)
    .replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{1,10});/gi, (whole, name: string) => {
      const n = name.toLowerCase();
      if (n.startsWith("#x")) return safeChar(parseInt(n.slice(2), 16), whole);
      if (n.startsWith("#")) return safeChar(parseInt(n.slice(1), 10), whole);
      return ENTITIES[n] ?? whole;
    })
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ ?\n[ \n]*/g, "\n")
    .trim();
}

function safeChar(code: number, fallback: string): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}
