/**
 * How the hint strip fits: the row packing, the shedding order and the
 * width arithmetic. Split from `hotkey-chips.ts` so that file stays the
 * strip's *policy* — which chips a state earns and in what order they
 * give way — and this one is how those chips are laid out. The two were
 * one 358-line file before the strip learned to wrap.
 */
import { theme } from "../theme/theme.js";
import type { HotkeyChip } from "./hotkey-chips.js";

/**
 * Lay the strip out over as many rows as it needs, up to `maxRows`.
 *
 * The strip used to be budgeted to exactly one row and fit by *deleting*
 * hints: at 83 columns — what a 120-column terminal leaves the chat
 * column once the rail has taken its share, which is to say the width
 * most operators actually run — the idle strip had shed `scroll`, the
 * sidebar key, `ctrl+r route` (the only keyboard way into the route
 * controls), `ctrl+n new window` and the text-selection hint. Five
 * affordances gone, silently, on a wide terminal, because the row they
 * live on was allowed one line.
 *
 * So the order of preference is now: **wrap, then shed, then clip.**
 * Chips are packed greedily in declared order (`packRows`), which keeps
 * the reading order the labels were written in. Only when the packing
 * needs more rows than the window can spare does a chip get dropped, and
 * only in the declared `shed` order. Essentials never disappear: once
 * nothing rankable is left, the overflow is folded into the last row and
 * `truncate-end` clips it, exactly as before.
 *
 * `maxRows` is the window's call, not this file's — see
 * `computeHintRowBudget` in `layout.ts`. It is what makes a short
 * terminal behave the way it used to: at one row, `layoutChipRows` is
 * `fitChips`.
 */
export function layoutChipRows(
  chips: readonly HotkeyChip[],
  width: number,
  maxRows: number,
): HotkeyChip[][] {
  const cap = Math.max(1, Math.floor(maxRows));
  let kept = [...chips];
  for (;;) {
    const rows = packRows(kept, width);
    if (rows.length <= cap) return rows;
    const next = nextToShed(kept);
    if (next < 0) return foldInto(rows, cap);
    kept = kept.filter((_, idx) => idx !== next);
  }
}

/**
 * Rows the strip will take at `width` — the same number
 * {@link layoutChipRows} lays out, for a caller that only needs the
 * height. Both go through one pure function of the same arguments, so
 * the height the layout budgets and the height the strip paints cannot
 * drift apart.
 */
export function countChipRows(
  chips: readonly HotkeyChip[],
  width: number,
  maxRows: number,
): number {
  return layoutChipRows(chips, width, maxRows).length;
}

/**
 * Greedy line-break in declared order. A chip wider than `width` on its
 * own still gets a row of its own and overflows it — there is nothing
 * else to do with it, and `truncate-end` is what the operator sees.
 */
function packRows(chips: readonly HotkeyChip[], width: number): HotkeyChip[][] {
  if (chips.length === 0) return [];
  const rows: HotkeyChip[][] = [];
  let row: HotkeyChip[] = [];
  let used = 0;
  for (const chip of chips) {
    const own = chipWidth(chip);
    const next = row.length === 0 ? own : used + SEPARATOR_WIDTH + own;
    if (row.length > 0 && next > width) {
      rows.push(row);
      row = [chip];
      used = own;
      continue;
    }
    row.push(chip);
    used = next;
  }
  rows.push(row);
  return rows;
}

/**
 * Squeeze `rows` into `cap` of them by concatenating the tail onto the
 * last one. Reached only when every remaining chip is essential and they
 * still do not fit: dropping one is not allowed, so the last row takes
 * the remainder and is clipped.
 */
function foldInto(rows: HotkeyChip[][], cap: number): HotkeyChip[][] {
  if (rows.length <= cap) return rows;
  const head = rows.slice(0, cap - 1);
  const tail = rows.slice(cap - 1).flat();
  return [...head, tail];
}

function nextToShed(chips: readonly HotkeyChip[]): number {
  let best = -1;
  let bestRank = Number.POSITIVE_INFINITY;
  chips.forEach((chip, idx) => {
    if (chip.shed === undefined || chip.shed >= bestRank) return;
    best = idx;
    bestRank = chip.shed;
  });
  return best;
}

/**
 * Columns between two chips: two spaces, the separator glyph, two more.
 */
const SEPARATOR_WIDTH = 4 + theme.glyphs.dotSeparator.length;

/**
 * Rendered columns of one chip: `[` + key + `] ` + label. Every key and
 * label we ship is single-width (ASCII plus `↑`, `↓`, `·`), so
 * `String.length` is the rendered width and we do not need a
 * `string-width` dependency here — keep new chips inside that alphabet.
 */
function chipWidth(chip: HotkeyChip): number {
  return chip.key.length + chip.label.length + 3;
}

/** Rendered columns of a whole row of chips. */
export function stripWidth(chips: readonly HotkeyChip[]): number {
  if (chips.length === 0) return 0;
  const chipWidths = chips.reduce((acc, chip) => acc + chipWidth(chip), 0);
  return chipWidths + (chips.length - 1) * SEPARATOR_WIDTH;
}
