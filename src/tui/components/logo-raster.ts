/**
 * Scales the brand mark to any size from one drawing.
 *
 * The mark used to ship as three hand-drawn copies — 34×20, 17×10 and a
 * one-line text fallback. Hand copies drift: the half-size one had lost
 * the taper of the lower-right tail and read as a blob, and every new
 * breakpoint meant drawing the shape again by eye.
 *
 * So there is one drawing now, and every smaller size is measured off it.
 * Two details make that work in a terminal:
 *
 * - **Half blocks.** `▀` `▄` `█` split a cell into an upper and a lower
 *   pixel, so a cell grid of W×H carries a pixel grid of W×2H. Vertical
 *   resolution doubles, which is what stops a downscaled mark turning
 *   into a staircase.
 * - **Cell aspect.** A terminal cell is about twice as tall as it is
 *   wide, so one half-block pixel is roughly square. Scaling in that
 *   pixel space — rather than in cells — is what keeps the mark from
 *   being squashed, and it is why the source is measured as 34×40 rather
 *   than 34×20.
 *
 * Sampling is an area average with a coverage threshold, not
 * nearest-neighbour: at small sizes a thin arm covers only part of a
 * destination pixel, and nearest-neighbour drops exactly those arms —
 * which is what made the old half-size copy look broken.
 */

/** Upper pixel set. */
const UPPER = "▀";
/** Lower pixel set. */
const LOWER = "▄";
/** Both set. */
const BOTH = "█";

/**
 * Fraction of a destination pixel that must be covered by ink for it to
 * be drawn. Below 0.5 the mark fattens and the counter-space between the
 * arms fills in; above it, thin arms drop out at the smallest sizes.
 */
const COVERAGE_THRESHOLD = 0.38;

export interface RasterSize {
  /** Width in terminal cells. */
  columns: number;
  /** Height in terminal cells. */
  rows: number;
}

/**
 * A boolean ink mask. `true` is drawn, `false` is background — the
 * source art's shading characters (`:`, `-`, `@`, `#`, …) all count as
 * ink, because at any reduced size shading is noise.
 */
export type InkMask = readonly (readonly boolean[])[];

/** Turn character rows into an ink mask, padded to the widest row. */
export function toInkMask(rows: readonly string[]): InkMask {
  const width = rows.reduce((acc, row) => Math.max(acc, row.length), 0);
  return rows.map((row) => {
    const cells: boolean[] = [];
    for (let x = 0; x < width; x += 1) {
      const ch = row[x] ?? " ";
      cells.push(ch !== " ");
    }
    return cells;
  });
}

/**
 * Expand a cell mask into a pixel mask by doubling every row — one cell
 * row is two half-block pixels tall. This is what puts the source into
 * the square-pixel space the scaling maths assumes.
 */
function toPixels(mask: InkMask): InkMask {
  return mask.flatMap((row) => [row, row]);
}

/**
 * Fraction of the source rectangle `[x0,x1) × [y0,y1)` that is ink.
 * Partial cells at the edges count partially, which is the whole point:
 * it is what keeps a one-pixel arm visible when it lands between two
 * destination pixels.
 */
function coverage(
  pixels: InkMask,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): number {
  let ink = 0;
  let total = 0;
  const yStart = Math.floor(y0);
  const yEnd = Math.ceil(y1);
  const xStart = Math.floor(x0);
  const xEnd = Math.ceil(x1);
  for (let y = yStart; y < yEnd; y += 1) {
    const row = pixels[y];
    if (!row) continue;
    const yWeight = Math.min(y + 1, y1) - Math.max(y, y0);
    if (yWeight <= 0) continue;
    for (let x = xStart; x < xEnd; x += 1) {
      const xWeight = Math.min(x + 1, x1) - Math.max(x, x0);
      if (xWeight <= 0) continue;
      const weight = yWeight * xWeight;
      total += weight;
      if (row[x]) ink += weight;
    }
  }
  return total === 0 ? 0 : ink / total;
}

/**
 * Draw `source` at `size`, preserving its aspect ratio and centring the
 * result in the requested box. Returns exactly `size.rows` strings, each
 * exactly `size.columns` wide.
 *
 * The mark is never scaled **up** past its natural size — the source is
 * a drawing, not a vector, and enlarging it only exposes the pixel grid.
 * Callers that have room for the full mark should draw the source art
 * directly.
 */
export function rasteriseMark(
  source: InkMask,
  size: RasterSize,
): readonly string[] {
  const columns = Math.max(0, Math.floor(size.columns));
  const rows = Math.max(0, Math.floor(size.rows));
  if (columns === 0 || rows === 0) return [];

  const pixels = toPixels(source);
  const srcWidth = pixels[0]?.length ?? 0;
  const srcHeight = pixels.length;
  if (srcWidth === 0 || srcHeight === 0) return [];

  // Destination pixel grid: full width, two pixels per cell row.
  const boxWidth = columns;
  const boxHeight = rows * 2;
  const scale = Math.min(boxWidth / srcWidth, boxHeight / srcHeight, 1);
  const drawWidth = Math.max(1, Math.round(srcWidth * scale));
  const drawHeight = Math.max(2, Math.round(srcHeight * scale));
  const padX = Math.floor((boxWidth - drawWidth) / 2);
  const padY = Math.floor((boxHeight - drawHeight) / 2);

  const lit: boolean[][] = [];
  for (let y = 0; y < boxHeight; y += 1) {
    const row: boolean[] = new Array(boxWidth).fill(false);
    const srcY0 = ((y - padY) * srcHeight) / drawHeight;
    const srcY1 = ((y - padY + 1) * srcHeight) / drawHeight;
    if (y >= padY && y < padY + drawHeight) {
      for (let x = 0; x < boxWidth; x += 1) {
        if (x < padX || x >= padX + drawWidth) continue;
        const srcX0 = ((x - padX) * srcWidth) / drawWidth;
        const srcX1 = ((x - padX + 1) * srcWidth) / drawWidth;
        row[x] = coverage(pixels, srcX0, srcX1, srcY0, srcY1) >= COVERAGE_THRESHOLD;
      }
    }
    lit.push(row);
  }

  const out: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    const top = lit[r * 2] ?? [];
    const bottom = lit[r * 2 + 1] ?? [];
    let line = "";
    for (let x = 0; x < boxWidth; x += 1) {
      const t = top[x] === true;
      const b = bottom[x] === true;
      line += t && b ? BOTH : t ? UPPER : b ? LOWER : " ";
    }
    out.push(line.trimEnd().padEnd(boxWidth));
  }
  return out;
}
