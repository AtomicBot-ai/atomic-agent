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
 * The byte caps bound memory, not time. This runs synchronously in main, so
 * the XML is walked by `scan` below with indexOf, in one pass over each part:
 * no regular expression that searches for a closing tag, which on a part with
 * many openings and no closing (a few KB compressed) would rescan to the end
 * from every opening and freeze the app. The few regexes left run on one tag's
 * attributes or one element's text and cannot backtrack across it. Pure: no
 * Electron import (tested from `out/main`).
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
  /** `renderable` (ATO-2410, set by main): this machine can draw the slides (slide-render.ts); the window then asks for the pictures. */
  | { type: "pptx"; slides: { n: number; title: string; paras: string[] }[]; total: number; truncated: boolean; renderable?: boolean }
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
/** `duplicates`: some name appeared twice in the central directory (only the first is kept in `entries`). */
type Zip = { entries: Map<string, Entry>; duplicates: boolean; read: (name: string) => string | null };

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
  let duplicates = false;
  let p = cdOff;
  for (let k = 0; k < Math.min(count, limits.entries); k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const nameLen = buf.readUInt16LE(p + 28);
    const end = p + 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (end > buf.length) return null;
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (entries.has(name)) duplicates = true;
    else {
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
  return { entries, duplicates, read };
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

/** An element (its text runs to its closing tag) or a lone tag (only its attributes are read). */
type Kind = "el" | "tag";

/** Whether the character at `j` ends a tag name: XML whitespace, '>' or '/'. */
function endsName(xml: string, j: number): boolean {
  const c = xml.charCodeAt(j);
  return c === 62 || c === 47 || c === 32 || c === 9 || c === 10 || c === 13;
}

/**
 * Calls `each` for every tag in `xml` named in `names`, in document order, in
 * one linear pass. `attrs` is what follows the name up to the tag's first '>'
 * (a trailing '/' left out); `closed` says it was `<name .../>`. For an "el"
 * name that is not self-closing, `inner` is the text up to the first
 * `</name>` after it, and the walk goes on after that closing tag (what the
 * lazy regexes this replaces took). A tag with no '>' or an element with no
 * closing tag ends the whole walk: nothing after it can close, and trying the
 * next opening again is what was quadratic. `each` returns false to stop.
 */
function scan(
  xml: string,
  names: Record<string, Kind>,
  each: (name: string, attrs: string, inner: string | null, closed: boolean) => boolean | void,
): void {
  const list = Object.entries(names);
  let pos = 0;
  for (;;) {
    const i = xml.indexOf("<", pos);
    if (i < 0) return;
    pos = i + 1;
    const hit = list.find(([n]) => xml.startsWith(n, i + 1) && endsName(xml, i + 1 + n.length));
    if (!hit) continue;
    const [name, kind] = hit;
    const from = i + 1 + name.length;
    const gt = xml.indexOf(">", from);
    if (gt < 0) return;
    const closed = gt > from && xml.charCodeAt(gt - 1) === 47;
    const attrs = xml.slice(from, closed ? gt - 1 : gt);
    let inner: string | null = null;
    pos = gt + 1;
    if (kind === "el" && !closed) {
      const close = "</" + name + ">";
      const end = xml.indexOf(close, pos);
      if (end < 0) return;
      inner = xml.slice(pos, end);
      pos = end + close.length;
    }
    if (each(name, attrs, inner, closed) === false) return;
  }
}

/** The attributes of the first `name` tag that `ok` accepts, or null. */
function findTag(xml: string, name: string, ok: (attrs: string) => boolean): string | null {
  let found: string | null = null;
  scan(xml, { [name]: "tag" }, (_n, attrs) => {
    if (!ok(attrs)) return;
    found = attrs;
    return false;
  });
  return found;
}

/** The inner XML of the first `name` element (not self-closing) that `ok` accepts, or null. */
function firstInner(xml: string, name: string, ok: (inner: string) => boolean): string | null {
  let found: string | null = null;
  scan(xml, { [name]: "el" }, (_n, _a, inner) => {
    if (inner === null || !ok(inner)) return;
    found = inner;
    return false;
  });
  return found;
}

/** The paragraphs of DrawingML text (<a:p> joining its <a:t> runs), blank ones dropped. */
function drawingParas(xml: string): string[] {
  const out: string[] = [];
  scan(xml, { "a:p": "el" }, (_p, _a, para) => {
    if (para === null) return;
    let t = "";
    scan(para, { "a:t": "el", "a:br": "tag" }, (name, _attrs, text, closed) => {
      if (name === "a:t") { if (text !== null) t += decodeXml(text); }
      else if (closed) t += "\n";
    });
    t = t.trim();
    if (t) out.push(t);
  });
  return out;
}

/** Whether a <p:sp> shape's inner XML holds the slide's title placeholder. */
function isTitleShape(inner: string): boolean {
  return findTag(inner, "p:ph", (a) => /type="(?:title|ctrTitle)"/.test(a)) !== null;
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
    const titleShape = firstInner(xml, "p:sp", isTitleShape);
    let paras = drawingParas(xml);
    const own: string[] = titleShape !== null ? drawingParas(titleShape) : paras.slice(0, 1);
    // The title's paragraphs are not repeated under it: the first occurrence
    // of each is dropped, in one pass (one indexOf + copy per title paragraph
    // was quadratic on a title shape with many paragraphs).
    const drop = new Map<string, number>();
    for (const o of own) drop.set(o, (drop.get(o) ?? 0) + 1);
    paras = paras.filter((p) => {
      const k = drop.get(p);
      if (!k) return true;
      drop.set(p, k - 1);
      return false;
    });
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
  scan(xml, { "w:p": "el" }, (_p, _a, para) => {
    if (para === null) return;   // <w:p/>: empty
    let t = "";
    // Only the bare <w:tab/>, <w:br/> and <w:cr/> are breaks (a <w:tab w:val=.../> is a tab stop in pPr).
    scan(para, { "w:t": "el", "w:tab": "tag", "w:br": "tag", "w:cr": "tag" }, (name, attrs, text, closed) => {
      if (name === "w:t") { if (text !== null) t += decodeXml(text); }
      else if (closed && attrs === "") t += name === "w:tab" ? "\t" : "\n";
    });
    t = t.trim();
    if (!t) return;
    if (paras.length >= L.paras) { more = true; return false; }
    const kept = chars.take(t);
    if (kept === null) return false;
    // Linear: `[^"]*` stops at the next quote, and every later match attempt starts past one.
    const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(para);
    const lvl = style ? /^heading\s?([1-6])$/i.exec(style[1]) : null;
    const heading = lvl ? Number(lvl[1]) : style && /^title$/i.test(style[1]) ? 1 : undefined;
    paras.push(heading ? { text: kept, heading } : { text: kept });
    if (chars.cut) return false;
  });
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
  // An <rPh> is walked over whole, so the <t> inside it is not read.
  scan(xml, { rPh: "el", t: "el" }, (name, _a, text) => { if (name === "t" && text !== null) t += decodeXml(text); });
  return t;
}
/** One attribute of a tag's attribute text. Linear: `[^"]*` stops at the next quote. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp("(?:^|\\s)" + name + "=\"([^\"]*)\"").exec(tag);
  return m ? decodeXml(m[1]) : null;
}

function xlsx(zip: Zip, L: typeof OFFICE_LIMITS): OfficePreview | null {
  const wb = zip.read("xl/workbook.xml");
  if (wb === null) return null;
  // <sheet followed by whitespace (not <sheets>, <sheetPr>); its attributes.
  const sheetTags: string[] = [];
  scan(wb, { sheet: "tag" }, (_n, attrs) => {
    if (!/^\s/.test(attrs)) return;
    if (sheetTags.length >= L.sheets) return false;
    sheetTags.push(attrs);
  });
  const sheets = sheetTags.map((t) => attr(t, "name") ?? "");
  // The first sheet's part, through the workbook's relationships; sheet1.xml when they say nothing.
  let part = "xl/worksheets/sheet1.xml";
  const rid = sheetTags[0] ? attr(sheetTags[0], "r:id") : null;
  const rels = rid ? zip.read("xl/_rels/workbook.xml.rels") : null;
  if (rels && rid) {
    const rel = findTag(rels, "Relationship", (t) => /^\s/.test(t) && attr(t, "Id") === rid);
    const target = rel ? attr(rel, "Target") : null;
    if (target && !/^[a-z]+:/i.test(target)) part = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
  }
  const sheetXml = zip.read(part);
  if (sheetXml === null) return null;
  const sstXml = zip.entries.has("xl/sharedStrings.xml") ? zip.read("xl/sharedStrings.xml") : "";
  // Every bare <si> or <si/>, in order: a cell's t="s" value is an index into them.
  const shared: string[] = [];
  if (sstXml) scan(sstXml, { si: "el" }, (_n, attrs, inner) => { if (attrs === "") shared.push(inner ? runText(inner) : ""); });
  const chars = budget(L.chars);
  const grid: string[][] = [];
  let width = 0, cut = false, nextRow = 0;
  scan(sheetXml, { row: "el" }, (_r, rowAttrs, rowInner) => {
    const rAttr = attr(rowAttrs, "r");
    const ri = rAttr ? Number(rAttr) - 1 : nextRow;
    nextRow = ri + 1;
    if (!(ri >= 0) || ri >= L.rows) { cut = true; return false; }
    let nextCol = 0;
    scan(rowInner ?? "", { c: "el" }, (_c, cAttrs, cInner) => {
      const ref = attr(cAttrs, "r");
      const at = ref ? cellRef(ref) : null;
      const ci = at ? at.col : nextCol;
      nextCol = ci + 1;
      if (ci >= L.cols) { cut = true; return; }
      const t = attr(cAttrs, "t");
      const inner = cInner ?? "";
      // The first <v>…</v>: when the first <v> has no closing, no later one has.
      const vs = inner.indexOf("<v>");
      const ve = vs < 0 ? -1 : inner.indexOf("</v>", vs + 3);
      const v = ve < 0 ? null : inner.slice(vs + 3, ve);
      let s = "";
      if (t === "inlineStr") s = runText(inner);
      else if (v !== null) {
        const raw = decodeXml(v);
        if (t === "s") s = shared[Number(raw)] ?? "";
        else if (t === "b") s = raw === "1" ? "TRUE" : "FALSE";
        else if (t === "str" || t === "e") s = raw;
        else {
          const n = Number(raw);
          // 0.1+0.2 is stored as 0.30000000000000004: shown as Excel shows it, 15 digits.
          s = raw !== "" && Number.isFinite(n) ? String(Number(n.toPrecision(15))) : raw;
        }
      }
      if (!s) return;
      const kept = chars.take(s);
      if (kept === null) { cut = true; return false; }
      while (grid.length <= ri) grid.push([]);
      grid[ri][ci] = kept;
      width = Math.max(width, ci + 1);
    });
    if (chars.cut) { cut = true; return false; }
  });
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
