// ATO-2445: a Parquet file in the preview panel, read as a sortable table.
// main/parquet-preview.ts and file-preview.ts are tested against the built
// output (npm run build) and the fixtures in test/fixtures/parquet (written
// by pyarrow 14: six columns, five rows, in Snappy, ZSTD and GZIP; and 2,500
// rows in three row groups). The renderer's parquet-table.js runs in a vm
// with table-sort.js and file-preview.js, as the window loads them.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "parquet");
const { filePreview } = require("../out/main/file-preview.js");
const { parquetPreview, parquetCell, topColumns, bytesForRows, looksParquet, pageCompressors, PARQUET_MAX_ROWS, PARQUET_MAX_READ_BYTES } = require("../out/main/parquet-preview.js");

const home = mkdtempSync(join(tmpdir(), "pq-home-"));
after(() => rmSync(home, { recursive: true, force: true }));
const P = process.platform;
const COLS = ["id", "name", "score", "when", "tags", "big"];

for (const codec of ["snappy", "zstd", "gzip"]) {
  test(`a ${codec} Parquet file comes back as its columns and rows, every cell as text`, async () => {
    const f = join(home, `people-${codec}.parquet`);
    copyFileSync(join(FIX, `people-${codec}.parquet`), f);
    const r = await filePreview(f, [home], home, P);
    assert.equal(r.ok, true);
    assert.equal(r.kind, "parquet", "not 'other': the table is read");
    assert.deepEqual(r.table.columns, COLS);
    assert.equal(r.table.totalRows, 5);
    assert.equal(r.table.rows.length, 5);
    assert.deepEqual(r.table.rows[0].slice(0, 3), ["3", "carol", "2.5"]);
    assert.equal(r.table.rows[4][0], "", "a null is an empty cell");
    assert.match(r.table.rows[0][3], /^2026-01-01T12:00:00/);
    assert.equal(r.table.rows[0][4], '["a","b"]');
    assert.equal(r.table.rows[0][5], "9007199254740993", "a 64-bit integer keeps every digit");
    assert.equal(r.text, undefined);
  });
}

test("only the first rows are read, and the file's own row count comes back", async () => {
  const fh = await open(join(FIX, "rows-2500.parquet"), "r");
  try {
    const st = await fh.stat();
    const r = await parquetPreview(fh, st.size);
    assert.equal(r.ok, true);
    assert.equal(r.table.totalRows, 2500);
    assert.equal(r.table.rows.length, PARQUET_MAX_ROWS);
    assert.deepEqual(r.table.rows[999], ["999", "row 999"]);
    const few = await parquetPreview(fh, st.size, { rows: 10, cols: 1 });
    assert.equal(few.table.rows.length, 10);
    assert.deepEqual(few.table.columns, ["n"]);
    assert.equal(few.table.colsCut, true);
    const tight = await parquetPreview(fh, st.size, { readBytes: 10 });
    assert.deepEqual(tight, { ok: false, note: "too-large" }, "row groups past the read cap are not read");
  } finally {
    await fh.close();
  }
});

test("every codec, Snappy too, refuses a page that claims to unpack past the read cap before allocating it", () => {
  let called = 0;
  const c = pageCompressors(() => { called++; });
  assert.ok(c.SNAPPY && c.GZIP && c.BROTLI, "Snappy is not left to hyparquet's own uncapped path");
  for (const codec of Object.keys(c)) {
    assert.throws(() => c[codec](new Uint8Array(4), PARQUET_MAX_READ_BYTES + 1), /page too large/, codec);
    assert.throws(() => c[codec](new Uint8Array(4), -1), /page too large/, codec);
  }
  assert.equal(called, 0, "the Snappy decoder never ran for a refused page");
  const out = pageCompressors((input, page) => { called++; page.set(input); }).SNAPPY(new Uint8Array([1, 2, 3]), 3);
  assert.deepEqual([...out], [1, 2, 3], "a page within the cap is unpacked into a buffer of its stated size");
});

test("a .parquet name on something that is not Parquet is no table", async () => {
  const f = join(home, "fake.parquet");
  writeFileSync(f, "id,name\n1,a\n");
  const r = await filePreview(f, [home], home, P);
  assert.equal(r.ok, true);
  assert.equal(r.kind, "other");
  assert.equal(r.note, "binary");
  const cut = join(home, "cut.parquet");
  writeFileSync(cut, readFileSync(join(FIX, "people-snappy.parquet")).subarray(0, 300));
  assert.equal((await filePreview(cut, [home], home, P)).kind, "other", "a truncated file has no footer");
});

test("cells, schema and row groups: the pure helpers", () => {
  assert.equal(parquetCell(null), "");
  assert.equal(parquetCell(12n), "12");
  assert.equal(parquetCell(true), "true");
  assert.equal(parquetCell(new Uint8Array(3)), "<3 bytes>");
  assert.equal(parquetCell({ a: 1n, b: new Uint8Array(2) }), '{"a":"1","b":"<2 bytes>"}');
  assert.equal(parquetCell("x".repeat(5000)).length, 1000);
  assert.equal(looksParquet(Buffer.from("PAR1")), true);
  assert.equal(looksParquet(Buffer.from("PK\x03\x04")), false);
  // root(2) -> a, b(list: 1 child -> element)
  assert.deepEqual(topColumns([{ name: "root", num_children: 2 }, { name: "a" }, { name: "b", num_children: 1 }, { name: "list", num_children: 1 }, { name: "element" }]), ["a", "b"]);
  assert.equal(bytesForRows([{ num_rows: 10n, total_byte_size: 100n, total_compressed_size: 40n }, { num_rows: 10n, total_byte_size: 100n }], 5), 40);
  assert.equal(bytesForRows([{ num_rows: 10n, total_byte_size: 100n, total_compressed_size: 40n }, { num_rows: 10n, total_byte_size: 100n }], 15), 140);
});

/* ---- renderer ---- */

function loadPanel() {
  const ctx = vm.createContext({ window: { atomic: {} }, setTimeout, clearTimeout, Intl, console });
  for (const f of ["table-sort.js", "parquet-table.js", "file-preview.js"]) {
    vm.runInContext(readFileSync(join(HERE, "..", "renderer", f), "utf8"), ctx, { filename: f });
  }
  return (code) => vm.runInContext(code, ctx);
}

test("the panel draws a Parquet table that sorts, and says how much of it is shown", () => {
  const run = loadPanel();
  const d = { ok: true, kind: "parquet", name: "t.parquet", ext: ".parquet", size: 9, mtimeMs: 1, path: "/h/t.parquet",
    table: { columns: ["n", "<b>"], rows: [["10", "x"], ["9", "y"], ["100", "z"]], totalRows: 52314, colsCut: false } };
  run("FP.data = " + JSON.stringify(d) + "; FP.sort = null;");
  const plain = run("fpBodyHtml(FP.data)");
  assert.match(plain, /Showing the first 3 of 52,314 rows\./);
  assert.match(plain, /data-fp="sort" data-fp-col="0"/);
  assert.match(plain, /&lt;b&gt;/, "a column name is escaped");
  assert.doesNotMatch(plain, /Edit/, "a Parquet table is not editable");
  run("FP.sort = {col: 0, dir: 'asc'};");
  const sorted = run("fpBodyHtml(FP.data)");
  const at = (v) => sorted.indexOf("<td>" + v + "</td>");
  assert.ok(at("9") < at("10") && at("10") < at("100"), "numbers by value");
  assert.match(sorted, /sorted among themselves/);
});

test("an unreadable codec says so instead of a bare 'no preview'", () => {
  const run = loadPanel();
  const html = run("fpBodyHtml(" + JSON.stringify({ ok: true, kind: "other", note: "unsupported", name: "a.parquet", size: 3 }) + ")");
  assert.match(html, /compression cannot be read here/);
});
