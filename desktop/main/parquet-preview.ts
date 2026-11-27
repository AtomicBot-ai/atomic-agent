/**
 * ATO-2445: a Parquet file in the preview panel, read as a table.
 *
 * file-preview.ts hands over the file handle it already checked (the root
 * check, links resolved, the very file by dev/inode), and this reads the
 * start of the table through hyparquet (MIT, pure JavaScript, no native
 * code, no dependencies of its own). Nothing is read whole: hyparquet asks
 * for the footer and then only the row groups that hold the first rows, by
 * byte range, through the same handle.
 *
 * What comes back is plain text, one string per cell, at most
 * PARQUET_MAX_ROWS rows and PARQUET_MAX_COLS columns, each cell cut at
 * PARQUET_MAX_CELL characters, and the file's own row count, so the window
 * can say "Showing the first 1,000 of 52,314 rows" (as Kilo Desktop's files
 * tab and VS Code's Parquet viewers do).
 *
 * Compression: Snappy is built into hyparquet; GZIP, Brotli and ZSTD come
 * from Node's own zlib. A codec neither knows (LZ4, LZO) answers
 * "unsupported", and the window keeps Open and Reveal.
 *
 * Guards: the footer is checked by hand first (the PAR1 mark, a metadata
 * length that fits the file and PARQUET_MAX_META_BYTES); the row groups that
 * would have to be read for the first rows must fit PARQUET_MAX_READ_BYTES;
 * a page that says it unpacks to more than that is refused, in every codec
 * (Snappy too: hyparquet's own Snappy path would allocate the size the page
 * header claims before unpacking, so Snappy goes through the same check).
 *
 * No Electron import, so the unit suite loads it from `out/main`.
 */

import type { FileHandle } from "node:fs/promises";
import * as zlib from "node:zlib";

export const PARQUET_MAX_ROWS = 1000;
export const PARQUET_MAX_COLS = 200;
export const PARQUET_MAX_CELL = 1000;
export const PARQUET_MAX_META_BYTES = 16 * 1024 * 1024;
export const PARQUET_MAX_READ_BYTES = 256 * 1024 * 1024;

export type ParquetTable = {
  /** The column names shown, in the file's order. */
  columns: string[];
  /** The first rows, every cell as text. */
  rows: string[][];
  /** Rows in the whole file. */
  totalRows: number;
  /** More columns than are shown. */
  colsCut: boolean;
};

export type ParquetResult =
  | { ok: true; table: ParquetTable }
  | { ok: false; note: "binary" | "too-large" | "unsupported" };

/** A Parquet file begins and ends with the four bytes `PAR1`. */
export function looksParquet(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x41 && head[2] === 0x52 && head[3] === 0x31;
}

type Decompress = (input: Uint8Array, outputLength: number) => Uint8Array;
type Lib = {
  parquetMetadataAsync(file: unknown): Promise<Meta>;
  parquetRead(options: Record<string, unknown>): Promise<void>;
  snappyUncompress(input: Uint8Array, output: Uint8Array): void;
};
type Meta = {
  num_rows: bigint | number;
  schema: { name: string; num_children?: number }[];
  row_groups: { num_rows: bigint | number; total_byte_size: bigint | number; total_compressed_size?: bigint | number }[];
};

let lib: Lib | null = null;
/** hyparquet, loaded on the first Parquet file (an ES module; Node's require loads it). */
function hyparquet(): Lib {
  if (!lib) lib = require("hyparquet") as Lib;
  return lib;
}

/** Refuses a page that says it unpacks past the read cap, before anything is allocated. */
function checkPageSize(outputLength: number): void {
  if (!(outputLength >= 0) || outputLength > PARQUET_MAX_READ_BYTES) throw new Error("page too large");
}

/** A codec through zlib, refusing a page that says it unpacks past the read cap. */
function viaZlib(fn: ((b: Uint8Array, o: zlib.ZlibOptions) => Buffer) | undefined): Decompress | undefined {
  if (typeof fn !== "function") return undefined;
  return (input, outputLength) => {
    checkPageSize(outputLength);
    return fn(input, { maxOutputLength: Math.max(1, outputLength) });
  };
}

/**
 * The codecs handed to hyparquet, each behind the page-size check: Snappy
 * through hyparquet's own decoder (`snappy`), GZIP, Brotli and ZSTD through
 * zlib (ZSTD needs Node 22.15 or later, which Electron 44 has).
 */
export function pageCompressors(snappy: (input: Uint8Array, output: Uint8Array) => void): Record<string, Decompress> {
  const z = zlib as unknown as Record<string, ((b: Uint8Array, o: zlib.ZlibOptions) => Buffer) | undefined>;
  const out: Record<string, Decompress> = {
    SNAPPY: (input, outputLength) => {
      checkPageSize(outputLength);
      const page = new Uint8Array(outputLength);
      snappy(input, page);
      return page;
    },
  };
  const gzip = viaZlib(z.gunzipSync);
  const brotli = viaZlib(z.brotliDecompressSync);
  const zstd = viaZlib(z.zstdDecompressSync);
  if (gzip) out.GZIP = gzip;
  if (brotli) out.BROTLI = brotli;
  if (zstd) out.ZSTD = zstd;
  return out;
}

/** One cell as text: numbers as written (a 64-bit integer keeps every digit), dates as ISO, bytes as a count. */
export function parquetCell(v: unknown): string {
  const s = cellText(v);
  return s.length > PARQUET_MAX_CELL ? s.slice(0, PARQUET_MAX_CELL - 1) + "…" : s;
}
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "bigint" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString();
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  try {
    return JSON.stringify(v, (_k, x: unknown) =>
      typeof x === "bigint" ? x.toString()
        : x instanceof Uint8Array ? `<${x.length} bytes>`
          : x);
  } catch {
    return String(v);
  }
}

const num = (v: bigint | number | undefined): number => (v === undefined ? 0 : Number(v));

/** The top-level column names: the root's direct children in the flattened schema. */
export function topColumns(schema: Meta["schema"]): string[] {
  const names: string[] = [];
  const root = schema[0];
  if (!root) return names;
  let i = 1;
  const skip = (): void => {
    // Steps over one element and everything nested under it.
    const kids = schema[i]?.num_children ?? 0;
    i++;
    for (let k = 0; k < kids && i < schema.length; k++) skip();
  };
  for (let k = 0; k < (root.num_children ?? 0) && i < schema.length; k++) {
    names.push(String(schema[i].name));
    skip();
  }
  return names;
}

/** The bytes the row groups holding the first `rows` rows take on disk. */
export function bytesForRows(groups: Meta["row_groups"], rows: number): number {
  let seen = 0, bytes = 0;
  for (const g of groups) {
    if (seen >= rows) break;
    bytes += num(g.total_compressed_size ?? g.total_byte_size);
    seen += num(g.num_rows);
  }
  return bytes;
}

/** The start of the Parquet table `fh` holds; `size` is the file's size from the checked stat. */
export async function parquetPreview(
  fh: FileHandle,
  size: number,
  limits: { rows?: number; cols?: number; readBytes?: number } = {},
): Promise<ParquetResult> {
  const maxRows = limits.rows ?? PARQUET_MAX_ROWS;
  const maxCols = limits.cols ?? PARQUET_MAX_COLS;
  const maxRead = limits.readBytes ?? PARQUET_MAX_READ_BYTES;
  const readAt = async (start: number, end: number): Promise<ArrayBuffer> => {
    const len = Math.max(0, Math.min(end, size) - start);
    const buf = Buffer.alloc(len);
    let filled = 0;
    while (filled < len) {
      const { bytesRead } = await fh.read(buf, filled, len - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + filled) as ArrayBuffer;
  };
  if (size < 12) return { ok: false, note: "binary" };
  const tail = new Uint8Array(await readAt(size - 8, size));
  if (!looksParquet(tail.subarray(4))) return { ok: false, note: "binary" };
  const metaLen = new DataView(tail.buffer, tail.byteOffset).getUint32(0, true);
  if (metaLen > size - 12) return { ok: false, note: "binary" };
  if (metaLen > PARQUET_MAX_META_BYTES) return { ok: false, note: "too-large" };
  const file = { byteLength: size, slice: (start: number, end?: number) => readAt(start, end ?? size) };
  let pq: Lib;
  try { pq = hyparquet(); } catch { return { ok: false, note: "unsupported" }; }
  let meta: Meta;
  try { meta = await pq.parquetMetadataAsync(file); } catch { return { ok: false, note: "binary" }; }
  const all = topColumns(meta.schema);
  const columns = all.slice(0, maxCols);
  const totalRows = num(meta.num_rows);
  const want = Math.min(maxRows, totalRows);
  if (bytesForRows(meta.row_groups, want) > maxRead) return { ok: false, note: "too-large" };
  let raw: unknown[][] = [];
  if (want > 0 && columns.length > 0) {
    try {
      await pq.parquetRead({
        file, metadata: meta, columns, rowStart: 0, rowEnd: want, compressors: pageCompressors(pq.snappyUncompress),
        onComplete: (rows: unknown[][]) => { raw = rows; },
      });
    } catch (err) {
      return { ok: false, note: /compression|codec/i.test(String((err as Error)?.message)) ? "unsupported" : "binary" };
    }
  }
  const rows = raw.slice(0, want).map((r) => columns.map((_c, i) => parquetCell(Array.isArray(r) ? r[i] : undefined)));
  return { ok: true, table: { columns, rows, totalRows, colsCut: all.length > columns.length } };
}
