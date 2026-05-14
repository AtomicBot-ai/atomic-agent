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
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return text.split("\n");
  const out: string[] = [];
  for (const paragraph of text.replace(/\r\n/g, "\n").split("\n")) {
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
