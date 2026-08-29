import {
  ATOM_COLLISION_GLYPH,
  ATOM_GLYPH,
  type AtomBounds,
  type AtomFieldState,
} from "./atom-field.js";

/**
 * The field, flattened into rows a renderer can emit one `<Text>` at a
 * time.
 *
 * Composed into a character grid first, for the same reason `intro-art`
 * is: two atoms can overlap, and a grid resolves that into one glyph per
 * cell instead of two Ink runs fighting over the same column. It also
 * makes the placement a value a test can read rather than a frame it has
 * to parse.
 */

export interface AtomRun {
  readonly text: string;
  /** Painted in the collision colour rather than the field's own. */
  readonly hot: boolean;
}

/**
 * Exactly `bounds.rows` rows, each a list of runs with trailing blanks
 * trimmed. The length is exact on purpose: Ink 7 overlaps rather than
 * clips, so the caller reserves the rows and this fills every one of
 * them, empty or not.
 */
export function buildAtomRows(
  state: AtomFieldState,
  bounds: AtomBounds,
): AtomRun[][] {
  const rows = Math.max(0, Math.floor(bounds.rows));
  const columns = Math.max(0, Math.floor(bounds.columns));
  const glyphs: string[][] = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => " "),
  );
  const hot: boolean[][] = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => false),
  );
  for (const atom of state.atoms) {
    if (atom.dormantSteps > 0) continue;
    const row = Math.round(atom.row);
    if (row < 0 || row >= rows) continue;
    const left = Math.round(atom.column);
    // A hot atom changes shape, not just colour: the swap is what keeps
    // the collision visible on a terminal that drops the green.
    const shape = atom.hotSteps > 0 ? ATOM_COLLISION_GLYPH : ATOM_GLYPH;
    for (const [offset, glyph] of [...shape].entries()) {
      const column = left + offset;
      if (column < 0 || column >= columns) continue;
      // Hot wins over cold where two atoms overlap — glyph and colour
      // both, so a later cold atom cannot repaint a green cell with the
      // resting shape. A collision is the one thing on this screen
      // worth looking at.
      if (atom.hotSteps > 0) {
        glyphs[row]![column] = glyph;
        hot[row]![column] = true;
      } else if (hot[row]?.[column] !== true) {
        glyphs[row]![column] = glyph;
      }
    }
  }
  return glyphs.map((cells, index) => compressRow(cells, hot[index] ?? []));
}

/** Adjacent cells of the same colour become one run; trailing blanks go. */
function compressRow(cells: readonly string[], hot: readonly boolean[]): AtomRun[] {
  const runs: { text: string; hot: boolean }[] = [];
  for (const [index, glyph] of cells.entries()) {
    const isHot = hot[index] === true;
    const last = runs[runs.length - 1];
    if (last && last.hot === isHot) last.text += glyph;
    else runs.push({ text: glyph, hot: isHot });
  }
  const trailing = runs[runs.length - 1];
  if (trailing && trailing.text.trim().length === 0) runs.pop();
  else if (trailing) trailing.text = trailing.text.replace(/\s+$/u, "");
  return runs;
}
