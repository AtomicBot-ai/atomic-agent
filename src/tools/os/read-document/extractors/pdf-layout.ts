/**
 * Reading-order reconstruction for one PDF page, from the glyph runs
 * pdfjs's `getTextContent()` returns. Pure geometry, no PDF parsing, so
 * it is unit-tested with synthetic runs.
 *
 * pdfjs hands back runs in content-stream order with a transform per run
 * (`[a, b, c, d, x, y]`, PDF user space, y grows upwards). Stream order is
 * whatever the producing app wrote: often fine, but tables come out cell
 * by cell in arbitrary order, multi-column articles sometimes interleave,
 * and words on one visual line can be split across the stream. This
 * module rebuilds the page from coordinates instead:
 *
 * 1. Columns. Look for a vertical gutter: a band of x positions that
 *    (almost) no run crosses, in the middle part of the text box. Accept it
 *    only when both sides look like running prose (most lines fill most of
 *    their side's width) and sit side by side vertically. A key/value
 *    table also has a gutter, but its left cells are short, so it is not
 *    split and stays row by row. Runs crossing the gutter (a title, a
 *    full-width abstract or figure) are kept as full-width bands; the page
 *    is read band by band: left column, right column, then the band.
 *    Applied recursively, so three or four columns work too.
 * 2. Lines. Inside a region, runs are grouped by baseline with a tolerance
 *    relative to the font size (superscripts stay on their line) and
 *    sorted left to right.
 * 3. Spacing. A space is inserted where the gap between two runs is wider
 *    than a fraction of the font size; a gap several characters wide (a
 *    table column, a tab stop) becomes ` | ` when table rendering is on.
 *    A vertical gap clearly larger than the usual line spacing becomes a
 *    blank line, so paragraphs survive.
 *
 * A few rotated runs (the arXiv side stamp, an axis label) are appended
 * after the page body. A page that is mostly rotated or vertical text, or
 * has runs without coordinates, falls back to the previous stream-order
 * assembly, so the worst case for such a page is the old output.
 */

export interface PdfTextItem {
  str: string;
  transform?: readonly number[];
  hasEOL?: boolean;
  height?: number;
  width?: number;
}

export interface LayoutOptions {
  /** Render wide in-line gaps as ` | ` cell separators. Default true. */
  tables?: boolean;
}

interface Run {
  /** Position in content-stream order. */
  index: number;
  text: string;
  x0: number;
  x1: number;
  y: number;
  /** Font size estimate in user-space units. */
  h: number;
}

interface Line {
  y: number;
  x0: number;
  x1: number;
  h: number;
  text: string;
}

const MAX_COLUMN_DEPTH = 3;
/** Share of runs allowed to cross a gutter (titles, spanning figures). */
const GUTTER_CROSSING_SHARE = 0.08;
const MIN_LINES_PER_COLUMN = 4;

export function layoutPageText(
  items: readonly PdfTextItem[],
  options: LayoutOptions = {},
): string {
  const split = toRuns(items);
  if (!split) return assembleStreamOrder(items);
  const { runs, rotated } = split;
  if (runs.length === 0 && rotated.length === 0) return "";
  const body = renderLines(orderRegion(runs, 0, options.tables !== false));
  // A few rotated runs (the arXiv side stamp, a chart axis label) are read
  // after the page body in stream order instead of disabling the layout
  // pass for the whole page.
  const tail = rotated.length > 0 ? assembleStreamOrder(rotated) : "";
  return [body, tail].filter((t) => t.length > 0).join("\n\n");
}

/**
 * The original line assembly: follow stream order and break on a change
 * of baseline. Kept as the fallback for pages the geometric pass skips.
 */
export function assembleStreamOrder(items: readonly PdfTextItem[]): string {
  if (items.length === 0) return "";
  const lines: string[] = [];
  let currentLine = "";
  let lastY: number | null = null;

  for (const item of items) {
    const y = item.transform?.[5] ?? null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 1) {
      lines.push(currentLine.trimEnd());
      currentLine = "";
    }
    currentLine += item.str;
    if (item.hasEOL) {
      lines.push(currentLine.trimEnd());
      currentLine = "";
    }
    lastY = y ?? lastY;
  }
  if (currentLine.length > 0) lines.push(currentLine.trimEnd());
  return lines.filter((l) => l.length > 0).join("\n");
}

/**
 * `null` = this page needs the stream-order fallback: a run without
 * coordinates, or a page that is mostly rotated / vertical text (the x/y
 * reasoning below does not apply to it).
 */
function toRuns(
  items: readonly PdfTextItem[],
): { runs: Run[]; rotated: PdfTextItem[] } | null {
  const runs: Run[] = [];
  const rotated: PdfTextItem[] = [];
  for (const [index, item] of items.entries()) {
    if (typeof item.str !== "string" || item.str.trim().length === 0) continue;
    const t = item.transform;
    if (!t || t.length < 6) return null;
    const [a, b, c, d, x, y] = t as [number, number, number, number, number, number];
    if (
      Math.abs(b) > 0.01 * Math.abs(a) ||
      Math.abs(c) > 0.01 * Math.abs(d) ||
      a <= 0 ||
      d <= 0
    ) {
      rotated.push(item);
      continue;
    }
    const size = item.height && item.height > 0 ? item.height : Math.abs(d);
    const h = size > 0 ? size : 10;
    const width =
      item.width && item.width > 0 ? item.width : item.str.length * h * 0.5;
    // Leading/trailing spaces inside a run are geometry, not text: the gap
    // logic re-creates them, and keeping them would double them.
    runs.push({ index, text: item.str.trim(), x0: x, x1: x + width, y, h });
  }
  if (rotated.length > runs.length) return null;
  return { runs, rotated };
}

// ---------------------------------------------------------------- columns

function orderRegion(runs: Run[], depth: number, tables: boolean): Line[] {
  const gutter = depth < MAX_COLUMN_DEPTH ? findGutter(runs) : null;
  if (!gutter) return buildLines(runs, tables);

  const left: Run[] = [];
  const right: Run[] = [];
  const spanning: Run[] = [];
  for (const r of runs) {
    if (r.x1 <= gutter.start) left.push(r);
    else if (r.x0 >= gutter.end) right.push(r);
    else spanning.push(r);
  }
  if (!looksLikeColumns(left, right, tables)) return buildLines(runs, tables);

  if (spanning.length === 0) {
    return [
      ...orderRegion(left, depth + 1, tables),
      ...orderRegion(right, depth + 1, tables),
    ];
  }
  // Full-width bands split the page into stacked sections; each section is
  // read left column first, then right, then the band below it.
  const bands = buildLines(spanning, tables);
  const sectionOf = (r: Run): number => {
    let s = 0;
    for (const band of bands) {
      if (band.y > r.y + r.h * 0.5) s++;
      else break;
    }
    return s;
  };
  const out: Line[] = [];
  for (let s = 0; s <= bands.length; s++) {
    const l = left.filter((r) => sectionOf(r) === s);
    const rgt = right.filter((r) => sectionOf(r) === s);
    out.push(...orderRegion(l, depth + 1, tables), ...orderRegion(rgt, depth + 1, tables));
    const band = bands[s];
    if (band) out.push(band);
  }
  return out;
}

interface Gutter {
  start: number;
  end: number;
}

/**
 * Widest x band in the central 20–80% of the text box that at most
 * GUTTER_CROSSING_SHARE of runs cross, at least ~1.5 font sizes wide.
 */
function findGutter(runs: Run[]): Gutter | null {
  if (runs.length < MIN_LINES_PER_COLUMN * 2) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const r of runs) {
    minX = Math.min(minX, r.x0);
    maxX = Math.max(maxX, r.x1);
  }
  const span = maxX - minX;
  if (!(span > 0)) return null;
  const bins = Math.min(2000, Math.max(1, Math.ceil(span)));
  const scale = bins / span;
  const delta = new Int32Array(bins + 1);
  for (const r of runs) {
    const from = Math.max(0, Math.floor((r.x0 - minX) * scale));
    const to = Math.min(bins, Math.ceil((r.x1 - minX) * scale));
    delta[from]! += 1;
    delta[to]! -= 1;
  }
  const coverage = new Int32Array(bins);
  let cover = 0;
  for (let i = 0; i < bins; i++) {
    cover += delta[i]!;
    coverage[i] = cover;
  }
  const lo = Math.floor(bins * 0.2);
  const hi = Math.ceil(bins * 0.8);
  const minWidth = 1.5 * medianHeight(runs) * scale;
  const allowed = Math.max(1, Math.floor(runs.length * GUTTER_CROSSING_SHARE));
  // Tightest gutter first: a band nothing crosses beats a wider band one
  // ragged line crosses. Only if no clean band exists do we accept one
  // crossed by a few spanning runs (a title, a full-width figure).
  for (let level = 0; level <= allowed; level++) {
    const band = widestBand(coverage, lo, hi, level);
    if (band && band.to - band.from >= minWidth) {
      return { start: minX + band.from / scale, end: minX + band.to / scale };
    }
  }
  return null;
}

function widestBand(
  coverage: Int32Array,
  lo: number,
  hi: number,
  level: number,
): { from: number; to: number } | null {
  let best: { from: number; to: number } | null = null;
  let start = -1;
  for (let i = lo; i <= hi; i++) {
    const open = i < hi && i < coverage.length && coverage[i]! <= level;
    if (open && start === -1) start = i;
    if (!open && start !== -1) {
      if (!best || i - start > best.to - best.from) best = { from: start, to: i };
      start = -1;
    }
  }
  return best;
}

/**
 * Columns, not a table. Both sides need enough lines and must sit side by
 * side vertically. Then either signal is enough:
 *
 * - prose: on each side most lines fill most of the side's width
 *   (justified or ragged prose does; table cells and labels do not);
 * - stream order: the producer wrote one side, then the other (few
 *   left/right switches in content-stream order). That is how columns are
 *   written, while tables are usually written row by row. It also means a
 *   split never reorders a page whose stream was already column-wise.
 */
function looksLikeColumns(left: Run[], right: Run[], tables: boolean): boolean {
  const l = buildLines(left, tables);
  const r = buildLines(right, tables);
  if (l.length < MIN_LINES_PER_COLUMN || r.length < MIN_LINES_PER_COLUMN) return false;
  const top = (ls: Line[]) => Math.max(...ls.map((x) => x.y));
  const bottom = (ls: Line[]) => Math.min(...ls.map((x) => x.y));
  const overlap = Math.min(top(l), top(r)) - Math.max(bottom(l), bottom(r));
  const shorter = Math.min(top(l) - bottom(l), top(r) - bottom(r));
  if (shorter <= 0 || overlap < shorter * 0.5) return false;
  if (fillsWidth(l) && fillsWidth(r)) return true;
  return streamSwitches(left, right) <= Math.max(3, 0.2 * Math.min(l.length, r.length));
}

function streamSwitches(left: Run[], right: Run[]): number {
  const tagged = [
    ...left.map((r) => ({ index: r.index, side: 0 })),
    ...right.map((r) => ({ index: r.index, side: 1 })),
  ].sort((p, q) => p.index - q.index);
  let switches = 0;
  for (let i = 1; i < tagged.length; i++) {
    if (tagged[i]!.side !== tagged[i - 1]!.side) switches++;
  }
  return switches;
}

function fillsWidth(lines: Line[]): boolean {
  const x0 = Math.min(...lines.map((l) => l.x0));
  const x1 = Math.max(...lines.map((l) => l.x1));
  const width = x1 - x0;
  if (width <= 0) return false;
  const full = lines.filter((l) => l.x1 - l.x0 >= width * 0.6).length;
  return full >= lines.length * 0.5;
}

// ------------------------------------------------------------------ lines

function buildLines(runs: Run[], tables: boolean): Line[] {
  if (runs.length === 0) return [];
  // Top to bottom (PDF y grows upwards).
  const sorted = [...runs].sort((p, q) => q.y - p.y || p.x0 - q.x0);
  const groups: Run[][] = [];
  let current: Run[] = [];
  let baseline = 0;
  let size = 0;
  for (const r of sorted) {
    if (current.length > 0 && baseline - r.y > 0.5 * Math.max(size, r.h)) {
      groups.push(current);
      current = [];
    }
    if (current.length === 0 || r.h > size) {
      // The line's baseline follows its largest run, so a superscript read
      // first (it sits higher) does not split the body text off its line.
      baseline = r.y;
      size = r.h;
    }
    current.push(r);
  }
  if (current.length > 0) groups.push(current);
  return groups.map((g) => joinLine(g, tables));
}

function joinLine(runs: Run[], tables: boolean): Line {
  const ordered = [...runs].sort((p, q) => p.x0 - q.x0);
  let text = "";
  let prev: Run | null = null;
  let h = 0;
  for (const r of ordered) {
    h = Math.max(h, r.h);
    // Fake bold: some producers draw the same run twice, a hair apart.
    if (prev && r.text === prev.text && Math.abs(r.x0 - prev.x0) < 0.2 * r.h) continue;
    if (prev) {
      const gap = r.x0 - prev.x1;
      const unit = Math.max(prev.h, r.h);
      if (tables && gap > 2.5 * unit) text += " | ";
      else if (gap > 0.15 * unit) text += " ";
    }
    text += r.text;
    prev = prev && prev.x1 > r.x1 ? prev : r;
  }
  const first = ordered[0]!;
  return {
    y: Math.max(...ordered.map((r) => r.y)),
    x0: first.x0,
    x1: Math.max(...ordered.map((r) => r.x1)),
    h,
    text,
  };
}

function renderLines(lines: Line[]): string {
  if (lines.length === 0) return "";
  const steps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const dy = lines[i - 1]!.y - lines[i]!.y;
    if (dy > 0) steps.push(dy);
  }
  const typical = steps.length > 0 ? median(steps) : 0;
  let out = lines[0]!.text;
  for (let i = 1; i < lines.length; i++) {
    const dy = lines[i - 1]!.y - lines[i]!.y;
    const paragraph = typical > 0 && dy > typical * 1.6;
    out += (paragraph ? "\n\n" : "\n") + lines[i]!.text;
  }
  return out.trim();
}

function medianHeight(runs: Run[]): number {
  return median(runs.map((r) => r.h));
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
