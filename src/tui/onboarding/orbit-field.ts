/**
 * Where the small crosses sit around the mark on the intro screen.
 *
 * An ellipse, not a circle: a terminal cell is roughly 2.2× taller than
 * it is wide, so equal counts of rows and columns are not equal
 * distances. The vertical radius is therefore the horizontal one divided
 * by that aspect — draw a circle in cells and it reads as a wide oval.
 *
 * Pure and React-free so the placement can be asserted as a table rather
 * than by reading it back out of a rendered frame.
 */
export const CELL_ASPECT = 2.2;

export interface OrbitCell {
  column: number;
  row: number;
}

export interface OrbitFieldOptions {
  columns: number;
  rows: number;
  /** Centre of the ring, normally the centre of the mark. */
  center: OrbitCell;
  /** Horizontal radius in columns. The vertical one is derived. */
  radius: number;
  count: number;
  /** Rotation in radians, so a tier can offset its ring off the axes. */
  phase?: number;
  /** Rows the ring must not draw into (the mark, the wordmark, the footer). */
  reserved?: readonly { top: number; bottom: number }[];
}

/**
 * Ring positions, clipped to the viewport and to the reserved bands.
 * Returns fewer cells than `count` when the ring does not fit — the
 * caller draws what it gets rather than being handed coordinates that
 * would overlap the wordmark.
 */
export function computeOrbitField(options: OrbitFieldOptions): OrbitCell[] {
  const { columns, rows, center, radius, count } = options;
  const phase = options.phase ?? 0;
  const reserved = options.reserved ?? [];
  if (count <= 0 || radius <= 0) return [];
  const verticalRadius = radius / CELL_ASPECT;
  const cells: OrbitCell[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i += 1) {
    const angle = (2 * Math.PI * i) / count + phase;
    const column = Math.round(center.column + Math.cos(angle) * radius);
    const row = Math.round(center.row + Math.sin(angle) * verticalRadius);
    if (column < 0 || column >= columns) continue;
    if (row < 0 || row >= rows) continue;
    if (reserved.some((band) => row >= band.top && row <= band.bottom)) continue;
    const key = `${column},${row}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push({ column, row });
  }
  return cells;
}

/** Group ring cells by row, so a renderer can emit one `<Text>` per line. */
export function orbitRowMap(cells: readonly OrbitCell[]): Map<number, number[]> {
  const byRow = new Map<number, number[]>();
  for (const cell of cells) {
    const columns = byRow.get(cell.row) ?? [];
    columns.push(cell.column);
    byRow.set(cell.row, columns);
  }
  for (const columns of byRow.values()) columns.sort((a, b) => a - b);
  return byRow;
}
