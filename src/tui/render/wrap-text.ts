/**
 * Word-aware soft-wrap. Splits `text` into a list of physical
 * terminal rows that each fit into `width` columns. Preserves
 * existing newlines (every `\n` is a hard break, even when the line
 * would have fit on one row), and preserves leading whitespace on
 * continuation rows of a single paragraph so indented lists / code
 * keep their shape.
 *
 * Pure function — no React, no Ink. The chat-log line-builder uses it
 * to convert each message body into the per-row slice fed into the
 * line-window virtual scroller.
 */
/**
 * Terminal tab stop. Eight columns is what every terminal this runs in
 * uses, and there is no way to ask the host for it.
 */
const TAB_WIDTH = 8;

/**
 * Replace tabs with the spaces the terminal will draw in their place,
 * so a measured length equals a drawn width.
 *
 * Without this the wrapper counts a `\t` as one column and the terminal
 * draws up to eight, so the row overflows its budget and the terminal
 * clips whatever hangs past the edge. Seen in the field on git's own
 * output, which indents with tabs: every path in a "would be
 * overwritten by checkout" list lost exactly its last character —
 * `.ts` rendered as `.t` — while the untabbed lines around it wrapped
 * correctly. The tool result was intact; only the drawing was wrong,
 * which is the worst shape for this class of bug because nothing
 * upstream looks broken.
 */
export function expandTabs(line: string, tabWidth = TAB_WIDTH): string {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const ch of line) {
    if (ch !== "\t") {
      out += ch;
      continue;
    }
    out += " ".repeat(tabWidth - (out.length % tabWidth));
  }
  return out;
}

export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return text.split("\n").map((line) => expandTabs(line));
  const out: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const paragraph = expandTabs(raw);
    if (paragraph.length === 0) {
      out.push("");
      continue;
    }
    let remaining = paragraph;
    while (remaining.length > width) {
      let cut = lastSpaceBefore(remaining, width);
      if (cut <= 0) {
        // No reasonable word boundary in the leading slice — hard
        // cut at width. Better to chop a long URL than to overflow
        // the column budget and break the line buffer.
        cut = width;
        out.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut);
      } else {
        out.push(remaining.slice(0, cut).replace(/\s+$/u, ""));
        remaining = remaining.slice(cut).replace(/^\s+/u, "");
      }
    }
    out.push(remaining);
  }
  return out;
}

function lastSpaceBefore(text: string, max: number): number {
  for (let i = max; i > 0; i -= 1) {
    if (text[i] === " " || text[i] === "\t") return i;
  }
  return -1;
}
