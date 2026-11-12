/**
 * How many terminal cells a picture takes (ATO-660): its aspect ratio
 * kept, inside a bounded box so one image never pushes the chat off the
 * screen.
 *
 * The cell size in pixels is not known without asking the terminal, so
 * the usual monospace shape is assumed: a cell about twice as tall as it
 * is wide, around 8x16 px. A small picture is not blown up past that.
 */
export const MAX_IMAGE_COLS = 40;
export const MAX_IMAGE_ROWS = 12;

const CELL_ASPECT = 2; // cell height / cell width
const CELL_WIDTH_PX = 8;
const CELL_HEIGHT_PX = 16;

export interface CellBox {
  readonly cols: number;
  readonly rows: number;
}

export function fitImageCells(
  width: number,
  height: number,
  max: CellBox = { cols: MAX_IMAGE_COLS, rows: MAX_IMAGE_ROWS },
): CellBox {
  if (!(width > 0) || !(height > 0)) return { cols: 1, rows: 1 };
  const maxCols = Math.max(1, Math.min(max.cols, Math.ceil(width / CELL_WIDTH_PX)));
  const maxRows = Math.max(1, Math.min(max.rows, Math.ceil(height / CELL_HEIGHT_PX)));
  // Rows the picture needs at full width, in cell units.
  const rowsAtFullWidth = (maxCols * height) / (width * CELL_ASPECT);
  if (rowsAtFullWidth <= maxRows) {
    return { cols: maxCols, rows: Math.max(1, Math.round(rowsAtFullWidth)) };
  }
  const cols = Math.round((maxRows * width * CELL_ASPECT) / height);
  return { cols: Math.max(1, Math.min(maxCols, cols)), rows: maxRows };
}
