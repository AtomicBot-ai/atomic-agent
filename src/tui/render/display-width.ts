/**
 * Terminal display width of a string, and an end-truncation that fits
 * a number of columns and always ends in `…` when it cuts.
 *
 * For labels the TUI truncates itself instead of leaving it to Ink's
 * `wrap="truncate"`. Under Ink 8 a text node can be laid out one column
 * wider than the box around it (Yoga rounds text nodes up), and the next
 * control on the row then draws over the ellipsis. A label already cut
 * to its box's measured width never overflows it.
 *
 * Not a full Unicode width table: wide East Asian blocks and the common
 * emoji planes count two columns, combining marks, zero-width spaces and
 * variation selectors count none, everything else one. Model ids and
 * provider names are almost always ASCII, so this is a safety margin
 * rather than a typesetting engine. The repo has no direct width
 * dependency (see `widestLine`), and this keeps it that way.
 */

const ELLIPSIS = "…";

function codePointWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Columns `text` takes on a terminal row. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += codePointWidth(ch.codePointAt(0)!);
  return width;
}

/**
 * `text` cut from the end to at most `columns` columns. Unchanged when it
 * fits; otherwise the longest prefix that leaves room for `…`, then `…`.
 * Nothing at all below one column.
 */
export function truncateToWidth(text: string, columns: number): string {
  if (displayWidth(text) <= columns) return text;
  if (columns <= 0) return "";
  const room = columns - displayWidth(ELLIPSIS);
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = codePointWidth(ch.codePointAt(0)!);
    if (used + w > room) break;
    out += ch;
    used += w;
  }
  return `${out}${ELLIPSIS}`;
}
