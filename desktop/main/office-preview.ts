/**
 * ATO-981: what the preview panel shows of a Word, PowerPoint or Excel file.
 *
 * The agent writes .pptx, .docx and .xlsx files (ATO-537, ATO-541). They are
 * ZIP archives of XML, so the generic preview saw NUL bytes and said "no
 * preview". Here the archive is opened from a Buffer and only the text is
 * pulled out: each slide's title and paragraphs, a document's paragraphs with
 * their heading level, a workbook's sheet names and its first sheet as rows.
 * Nothing is laid out or rendered; the window draws the text (escaped).
 *
 * The desktop app ships no ZIP library, and this needs very little of one:
 * the central directory, stored and deflated entries (node:zlib). Every size
 * is capped so a crafted file (a "zip bomb", a huge sheet) cannot make main
 * allocate or loop without end: the entries looked at, each entry's inflated
 * size (zlib's maxOutputLength stops it mid-way), the total inflated, and the
 * slides, paragraphs, characters, rows and columns kept. Anything odd (ZIP64,
 * encryption, a bad offset, a missing part) gives null, never a throw, and
 * the panel falls back to name, size, Open and Reveal.
 *
 * XML is scanned with regular expressions: the parts are machine-written and
 * the caps bound the work. Pure: no Electron import (tested from `out/main`).
 */

import { inflateRawSync } from "node:zlib";

export type OfficeType = "pptx" | "docx" | "xlsx";

export const OFFICE_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const OFFICE_LIMITS = {
  entries: 5000,                  // central directory records looked at
  entryBytes: 8 * 1024 * 1024,    // one part, inflated
  totalBytes: 24 * 1024 * 1024,   // all parts read for one preview, inflated
  slides: 300,
  paras: 3000,
  chars: 300_000,                 // text kept in all
  rows: 500,
  cols: 50,
  sheets: 100,
};

export type OfficePreview =
  | { type: "pptx"; slides: { n: number; title: string; paras: string[] }[]; total: number; truncated: boolean }
  | { type: "docx"; paras: { text: string; heading?: number }[]; truncated: boolean }
  | { type: "xlsx"; sheets: string[]; sheet: string; rows: string[][]; truncated: boolean };

/** The Office type a file's extension names, or null. */
export function officeTypeFor(ext: string): OfficeType | null {
  const e = String(ext || "").toLowerCase();
  return e === ".pptx" ? "pptx" : e === ".docx" ? "docx" : e === ".xlsx" ? "xlsx" : null;
}

/** A ZIP's first bytes: a local file header. */
export function looksZip(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

type Entry = { method: number; flags: number; comp: number; size: number; local: number };
type Zip = { entries: Map<string, Entry>; read: (name: string) => string | null };

/** The archive's central directory, and a reader that inflates one part as UTF-8 within the caps. */
export function openZip(buf: Buffer, limits = OFFICE_LIMITS): Zip | null {
  if (buf.length < 22) return null;
  // The end-of-central-directory record: within the last 64 KB (its comment) + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  // 0xffff / 0xffffffff mean ZIP64: never what Office writes for a file this size.
  if (count === 0xffff || cdOff === 0xffffffff || cdOff + cdSize > buf.length) return null;
  const entries = new Map<string, Entry>();
  let p = cdOff;
  for (let k = 0; k < Math.min(count, limits.entries); k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const nameLen = buf.readUInt16LE(p + 28);
    const end = p + 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (end > buf.length) return null;
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (!entries.has(name)) {
      entries.set(name, {
        flags: buf.readUInt16LE(p + 8),
        method: buf.readUInt16LE(p + 10),
        comp: buf.readUInt32LE(p + 20),
        size: buf.readUInt32LE(p + 24),
        local: buf.readUInt32LE(p + 42),
      });
    }
    p = end;
  }
  let spent = 0;
  const read = (name: string): string | null => {
    const e = entries.get(name);
    if (!e || e.flags & 1) return null;   // missing, or encrypted
    const room = Math.min(limits.entryBytes, limits.totalBytes - spent);
    if (room <= 0 || e.size > room) return null;
    const h = e.local;
    if (h + 30 > buf.length || buf.readUInt32LE(h) !== 0x04034b50) return null;
    const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
    if (start + e.comp > buf.length) return null;
    const raw = buf.subarray(start, start + e.comp);
    let out: Buffer;
    if (e.method === 0 && raw.length <= room) out = raw;
    // The declared size can lie: zlib itself stops at `room` (a RangeError, caught here).
    else if (e.method === 8) try { out = inflateRawSync(raw, { maxOutputLength: room }); } catch { return null; }
    else return null;   // over the cap stored, or a method Office does not use
    spent += out.length;
    return out.toString("utf8");
  };
  return { entries, read };
}

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };
/** XML text with its entities (named and numeric) turned back into characters. */
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, ref: string) => {
    if (ref[0] !== "#") return ENTITY[ref] ?? m;
    const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** Counts the text kept; past the cap every later add is refused and the result says it was cut. */
function budget(limit: number) {
  let left = limit, cut = false;
  return {
    take(s: string): string | null {
      if (left <= 0) { cut = true; return null; }
      if (s.length > left) { cut = true; s = s.slice(0, left); }
      left -= s.length;
      return s;
    },
    get cut() { return cut; },
  };
}

/** The paragraphs of DrawingML text (<a:p> joining its <a:t> runs), blank ones dropped. */
function drawingParas(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<a:p(?=[\s>])[\s\S]*?<\/a:p>/g)) {
    let t = "";
    for (const r of m[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)) t += r[1] === undefined ? "\n" : decodeXml(r[1]);
    t = t.trim();
    if (t) out.push(t);
  }
  return out;
}

function pptx(zip: Zip, L: typeof OFFICE_LIMITS): OfficePreview | null {
  const names = [...zip.entries.keys()]
    .map((n) => { const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(n); return m ? { n: Number(m[1]), name: n } : null; })
    .filter((x): x is { n: number; name: string } => !!x)
    .sort((a, b) => a.n - b.n);
  if (!names.length) return null;
  const chars = budget(L.chars);
  const slides: { n: number; title: string; paras: string[] }[] = [];
  let paraCount = 0;
  for (const [i, s] of names.slice(0, L.slides).entries()) {
    const xml = zip.read(s.name);
    if (xml === null) break;   // over the byte caps: the slides so far are shown
    // The title is the text of the shape that is the slide's title placeholder, else its first paragraph.
    const titleShape = [...xml.matchAll(/<p:sp(?=[\s>])[\s\S]*?<\/p:sp>/g)].find((m) => /<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(m[0]));
    let paras = drawingParas(xml);
    const own = titleShape ? drawingParas(titleShape[0]) : paras.slice(0, 1);
    // The title's paragraphs are not repeated under it.
    for (const o of own) { const k = paras.indexOf(o); if (k >= 0) paras = [...paras.slice(0, k), ...paras.slice(k + 1)]; }
    const title = chars.take(own.join(" ")) ?? "";
    const kept: string[] = [];
    for (const p of paras) {
      if (paraCount >= L.paras) break;
      const t = chars.take(p);
      if (t === null) break;
      kept.push(t);
      paraCount++;
    }
    slides.push({ n: i + 1, title, paras: kept });
    if (chars.cut || paraCount >= L.paras) break;
  }
  if (!slides.length) return null;
  return { type: "pptx", slides, total: names.length, truncated: slides.length < names.length || chars.cut };
}

function docx(zip: Zip, L: typeof OFFICE_LIMITS): OfficePreview | null {
  const xml = zip.read("word/document.xml");
  if (xml === null) return null;
  const chars = budget(L.chars);
  const paras: { text: string; heading?: number }[] = [];
  let more = false;
  for (const m of xml.matchAll(/<w:p(?=[\s>])[\s\S]*?<\/w:p>/g)) {
    let t = "";
    for (const r of m[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\/>/g)) {
      t += r[1] !== undefined ? decodeXml(r[1]) : r[2] === "tab" ? "\t" : "\n";
    }
    t = t.trim();
    if (!t) continue;
    if (paras.length >= L.paras) { more = true; break; }
    const kept = chars.take(t);
    if (kept === null) break;
    const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(m[0]);
    const lvl = style ? /^heading\s?([1-6])$/i.exec(style[1]) : null;
    const heading = lvl ? Number(lvl[1]) : style && /^title$/i.test(style[1]) ? 1 : undefined;
    paras.push(heading ? { text: kept, heading } : { text: kept });
    if (chars.cut) break;
  }
  return { type: "docx", paras, truncated: more || chars.cut };
}

/** "C12" → column 2 (zero-based) and row 11, or null. */
function cellRef(r: string): { col: number; row: number } | null {
  const m = /^([A-Z]{1,3})(\d+)$/.exec(r);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}
/** The joined <t> text of a shared string or an inline string (rich runs included, phonetic hints left out). */
function runText(xml: string): string {
  let t = "";
  for (const r of xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) t += decodeXml(r[1]);
  return t;
}
function attr(tag: string, name: string): string | null {
  const m = new RegExp("(?:^|\\s)" + name + "=\"([^\"]*)\"").exec(tag);
  return m ? decodeXml(m[1]) : null;
}

function xlsx(zip: Zip, L: typeof OFFICE_LIMITS): OfficePreview | null {
  const wb = zip.read("xl/workbook.xml");
  if (wb === null) return null;
  const sheetTags = [...wb.matchAll(/<sheet\s([^>]*?)\/?>/g)].slice(0, L.sheets).map((m) => m[1]);
  const sheets = sheetTags.map((t) => attr(t, "name") ?? "");
  // The first sheet's part, through the workbook's relationships; sheet1.xml when they say nothing.
  let part = "xl/worksheets/sheet1.xml";
  const rid = sheetTags[0] ? attr(sheetTags[0], "r:id") : null;
  const rels = rid ? zip.read("xl/_rels/workbook.xml.rels") : null;
  if (rels && rid) {
    const rel = [...rels.matchAll(/<Relationship\s([^>]*?)\/?>/g)].map((m) => m[1]).find((t) => attr(t, "Id") === rid);
    const target = rel ? attr(rel, "Target") : null;
    if (target && !/^[a-z]+:/i.test(target)) part = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
  }
  const sheetXml = zip.read(part);
  if (sheetXml === null) return null;
  const sstXml = zip.entries.has("xl/sharedStrings.xml") ? zip.read("xl/sharedStrings.xml") : "";
  const shared = sstXml ? [...sstXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => (m[1] ? runText(m[1]) : "")) : [];
  const chars = budget(L.chars);
  const grid: string[][] = [];
  let width = 0, cut = false, nextRow = 0;
  for (const rm of sheetXml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rAttr = attr(rm[1], "r");
    const ri = rAttr ? Number(rAttr) - 1 : nextRow;
    nextRow = ri + 1;
    if (!(ri >= 0) || ri >= L.rows) { cut = true; break; }
    let nextCol = 0;
    for (const cm of (rm[2] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1], "r");
      const at = ref ? cellRef(ref) : null;
      const ci = at ? at.col : nextCol;
      nextCol = ci + 1;
      if (ci >= L.cols) { cut = true; continue; }
      const t = attr(cm[1], "t");
      const inner = cm[2] || "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      let s = "";
      if (t === "inlineStr") s = runText(inner);
      else if (v) {
        const raw = decodeXml(v[1]);
        if (t === "s") s = shared[Number(raw)] ?? "";
        else if (t === "b") s = raw === "1" ? "TRUE" : "FALSE";
        else if (t === "str" || t === "e") s = raw;
        else {
          const n = Number(raw);
          // 0.1+0.2 is stored as 0.30000000000000004: shown as Excel shows it, 15 digits.
          s = raw !== "" && Number.isFinite(n) ? String(Number(n.toPrecision(15))) : raw;
        }
      }
      if (!s) continue;
      const kept = chars.take(s);
      if (kept === null) { cut = true; break; }
      while (grid.length <= ri) grid.push([]);
      grid[ri][ci] = kept;
      width = Math.max(width, ci + 1);
    }
    if (chars.cut) { cut = true; break; }
  }
  const rows = grid.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));
  return { type: "xlsx", sheets, sheet: sheets[0] ?? "", rows, truncated: cut };
}

/** The text of an Office file held in `buf`, or null when it is not one this can read. */
export function officePreview(buf: Buffer, type: OfficeType, limits = OFFICE_LIMITS): OfficePreview | null {
  try {
    const zip = openZip(buf, limits);
    if (!zip) return null;
    return type === "pptx" ? pptx(zip, limits) : type === "docx" ? docx(zip, limits) : xlsx(zip, limits);
  } catch {
    return null;
  }
}
