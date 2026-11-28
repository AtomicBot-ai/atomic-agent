/* ---------------- ATO-2445: a Parquet file in the preview panel, as a table ----------------
   Loaded after table-sort.js and before file-preview.js, whose fpBodyHtml
   calls fpParquetHtml for a file main read as `kind: 'parquet'`
   (main/parquet-preview.ts). main sends the start of the table only: column
   names, the first rows (every cell already text) and the file's own row
   count. So the note says how much is shown ("Showing the first 1,000 of
   52,314 rows"), the way VS Code's Parquet viewers and Kilo Desktop's files
   tab do.

   A click on a column's header sorts by it, the same three-step sort a CSV
   table has (table-sort.js; file-preview.js keeps FP.sort and repaints),
   within the rows shown. Nothing here touches the DOM; fpEsc escapes every
   name and cell.

   Shared with the Node checks (test/parquet-preview.test.mjs): fpParquetHtml,
   fpParquetNote. */

/** "1,000" in the reader's digits grouping, without depending on their locale. */
function fpCount(n) {
  return String(Math.max(0, Math.floor(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The line over the table: how many rows (and columns) of the file are shown. */
function fpParquetNote(t, sorted) {
  const shown = t.rows.length, total = Number(t.totalRows) || 0;
  const parts = [];
  if (total > shown) parts.push('Showing the first ' + fpCount(shown) + ' of ' + fpCount(total) + ' rows' + (sorted ? ', sorted among themselves' : ''));
  if (t.colsCut) parts.push((parts.length ? 'the' : 'Showing the') + ' first ' + fpCount(t.columns.length) + ' columns');
  return parts.length ? parts.join(' and ') + '. Open the file to see all of it.' : '';
}

/** The table for `d.table`; the header cells sort (data-fp="sort"), as in fpTableHtml. */
function fpParquetHtml(d) {
  const t = d && d.table;
  if (!t || !Array.isArray(t.columns) || !Array.isArray(t.rows)) return '<div class="fp-msg">This file could not be read.</div>';
  if (!t.columns.length) return '<div class="fp-msg">This file has no columns.</div>';
  const cols = t.columns.length;
  const sort = typeof FP !== 'undefined' && FP.sort && FP.sort.col < cols && typeof tsSortRows === 'function' ? FP.sort : null;
  const body = sort ? tsSortRows(t.rows, sort.col, sort.dir) : t.rows;
  const th = (name, i) => {
    const on = sort && sort.col === i;
    const aria = on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return '<th class="fp-sortable' + (on ? ' on' : '') + '" data-fp="sort" data-fp-col="' + i + '" aria-sort="' + aria + '" title="Sort by this column">'
      + fpEsc(name == null ? '' : name) + (on ? '<span class="fp-sort-ic" aria-hidden="true">' + (sort.dir === 'asc' ? '▲' : '▼') + '</span>' : '') + '</th>';
  };
  const note = fpParquetNote(t, !!sort);
  const empty = !t.rows.length ? '<div class="fp-msg">The table has no rows.</div>' : '';
  return (note ? '<div class="fp-note">' + fpEsc(note) + '</div>' : '')
    + '<div class="prose fp-prose"><div class="mdtbl fp-tbl"><table><thead><tr>'
    + t.columns.map(th).join('') + '</tr></thead><tbody>'
    + body.map((r) => '<tr>' + t.columns.map((_c, i) => '<td>' + fpEsc(r && r[i] != null ? r[i] : '') + '</td>').join('') + '</tr>').join('')
    + '</tbody></table></div></div>' + empty;
}

if (typeof module !== 'undefined') module.exports = {fpParquetHtml, fpParquetNote, fpCount};
