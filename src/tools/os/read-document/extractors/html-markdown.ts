import { parseHTML } from "linkedom";
import TurndownService from "turndown";

/**
 * HTML → light markdown for documents on disk (saved web pages, EPUB
 * chapters, HTML mail bodies). Built on the same two libraries web fetch
 * already ships (`linkedom` for the DOM, `turndown` for markdown), so this
 * adds no dependency.
 *
 * Unlike web fetch we do NOT run Readability here: it is tuned for news
 * articles and drops content it scores as boilerplate, which on a local
 * document (a manual, a table-heavy report, an e-book chapter) is often
 * the content itself. We only strip elements that are never document text.
 */
const DROP_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "svg",
  "canvas",
  "head",
].join(",");

let turndown: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (turndown) return turndown;
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  // Turndown core has no table support: every cell becomes its own
  // paragraph and the row/column shape is lost. Render tables as pipe rows
  // with a header separator so a local model can still read them as a grid.
  td.addRule("tableCell", {
    filter: ["th", "td"],
    replacement: (content) => ` ${content.replace(/\s*\n+\s*/g, " ").trim()} |`,
  });
  td.addRule("tableRow", {
    filter: "tr",
    replacement: (content) => `\n|${content}`,
  });
  td.addRule("tableSection", {
    filter: ["thead", "tbody", "tfoot"],
    replacement: (content) => content,
  });
  td.addRule("table", {
    filter: "table",
    replacement: (content) => {
      const rows = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("|"));
      if (rows.length === 0) return "\n\n";
      const columns = Math.max(1, (rows[0]!.match(/\|/g)?.length ?? 2) - 1);
      const separator = `|${" --- |".repeat(columns)}`;
      return `\n\n${[rows[0], separator, ...rows.slice(1)].join("\n")}\n\n`;
    },
  });
  td.remove(["button", "input", "select", "textarea"]);
  turndown = td;
  return td;
}

export interface HtmlMarkdown {
  text: string;
  title?: string;
}

export function htmlToMarkdown(html: string): HtmlMarkdown {
  // linkedom does not synthesise <html>/<body> around a fragment the way a
  // browser does (the first element becomes the document element), so a
  // bare `<table>…` or a mail body without a wrapper is wrapped first.
  const wrapped = /<body[\s>]/i.test(html) ? html : `<!doctype html><html><head></head><body>${html}</body></html>`;
  const { document } = parseHTML(wrapped);
  const title = document.querySelector("title")?.textContent?.trim() || undefined;
  for (const node of Array.from(document.querySelectorAll(DROP_SELECTOR))) {
    (node as { remove(): void }).remove();
  }
  const body = document.body as { innerHTML?: string } | null;
  const source =
    body?.innerHTML && body.innerHTML.trim().length > 0
      ? body.innerHTML
      : (document.documentElement as { innerHTML?: string } | null)?.innerHTML ?? "";
  const markdown = getTurndown()
    .turndown(source)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: markdown, title };
}
