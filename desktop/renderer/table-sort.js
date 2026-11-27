/* ---------------- ATO-2347: a CSV/TSV table in the preview, sorted by a column ----------------
   Loaded before file-preview.js, which draws the table and calls these. A
   click on a column's header sorts by it, again reverses, a third time puts
   the file's own order back (as in a spreadsheet or VS Code's CSV previews).

   Cells that read as numbers compare as numbers (`1,234.5`, `-3`, `12%`,
   `1e3`), other text in the reader's language with digits in their numeric
   order ("file 2" before "file 10"), case aside. Empty cells stay at the
   bottom either way. The sort is stable: equal cells keep the file's order.

   Shared with the Node checks (test/file-preview-edit.test.mjs):
   tsNumber, tsCompareCells, tsSortRows, tsNextSort. */

const TS_COLLATOR = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'}) : null;
const TS_NUMBER_RE = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:e[-+]?\d+)?%?$/i;

/** The number a cell reads as, or NaN: thousands commas and a trailing % allowed, nothing else around it. */
function tsNumber(cell) {
  const s = String(cell == null ? '' : cell).trim();
  if (!s || !/\d/.test(s) || !TS_NUMBER_RE.test(s)) return NaN;
  return Number(s.replace(/,/g, '').replace(/%$/, ''));
}

/** Two cells in ascending order: numbers by value and before text, text by the collator. Empty cells are not compared here. */
function tsCompareCells(a, b) {
  const x = tsNumber(a), y = tsNumber(b);
  const xn = !Number.isNaN(x), yn = !Number.isNaN(y);
  if (xn && yn) return x < y ? -1 : x > y ? 1 : 0;
  if (xn !== yn) return xn ? -1 : 1;
  const s = String(a == null ? '' : a), t = String(b == null ? '' : b);
  if (TS_COLLATOR) return TS_COLLATOR.compare(s, t);
  return s < t ? -1 : s > t ? 1 : 0;
}

/** The rows (header not among them) sorted by column `col`, `dir` 'asc' or 'desc'; a new array, empty cells last. */
function tsSortRows(rows, col, dir) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!(col >= 0) || (dir !== 'asc' && dir !== 'desc')) return list;
  const sign = dir === 'desc' ? -1 : 1;
  const blank = (r) => { const v = r && r[col]; return v == null || String(v).trim() === ''; };
  return list
    .map((r, i) => ({r, i}))
    .sort((p, q) => {
      const pb = blank(p.r), qb = blank(q.r);
      if (pb || qb) return pb === qb ? p.i - q.i : pb ? 1 : -1;
      return sign * tsCompareCells(p.r[col], q.r[col]) || p.i - q.i;
    })
    .map((e) => e.r);
}

/** The sort after a click on column `col`: ascending, then descending, then none (the file's order). */
function tsNextSort(cur, col) {
  if (!cur || cur.col !== col) return {col, dir: 'asc'};
  if (cur.dir === 'asc') return {col, dir: 'desc'};
  return null;
}

if (typeof module !== 'undefined') module.exports = {tsNumber, tsCompareCells, tsSortRows, tsNextSort};
