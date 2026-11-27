/**
 * ATO-2517 (review of #2111): whether one relationship part (`*.rels`) of a
 * deck points outside the file, read the way an XML parser reads it, not by
 * a pattern over its bytes. LibreOffice and PowerPoint (opened by automation,
 * with no Protected View) may fetch a linked picture, video or object while
 * they draw: a `file://host/share` or `\\host\share` target sends the user's
 * Windows sign-in hash to that host, an `http:` one is a remote fetch. So the
 * answer has to be the one PowerPoint would read, and fails closed.
 *
 * - The bytes are decoded by their byte-order mark, or by the UTF-16 shape of
 *   a first `<` without one, as XML 1.0 Appendix F does; the XML declaration
 *   must name the same family. Anything else (UTF-32, a legacy code page, a
 *   byte that is not valid UTF-8, a NUL) is "cannot tell".
 * - A document type declaration is refused: it can define an entity
 *   (`TargetMode="&e;"`) or give TargetMode a default value.
 * - Every start tag's attributes are read with their quotes, and each value
 *   has its character and entity references resolved (`&#69;xternal` is
 *   External); an undefined entity, a stray `<` or quote, a repeated
 *   attribute or a tag with no end is "cannot tell".
 * - Any element whose TargetMode is not Internal, or whose Target is an
 *   absolute URI (`scheme:`) or a network path (`//`, `\`), links out.
 *
 * Linear: one pass, each search starts where the last ended. Pure.
 */

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

function utf16(b: Buffer, bigEndian: boolean): string | null {
  if (b.length % 2) return null;
  return (bigEndian ? Buffer.from(b).swap16() : b).toString("utf16le");
}

/** The text of an XML part by its encoding, or null when that is not UTF-8 or UTF-16 (or the bytes do not decode cleanly). */
export function decodeXmlBytes(raw: Uint8Array): string | null {
  const b = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  let text: string | null;
  let family: "utf-8" | "utf-16";
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) { text = b.subarray(3).toString("utf8"); family = "utf-8"; }
  else if (b[0] === 0xff && b[1] === 0xfe) {
    if (b[2] === 0 && b[3] === 0) return null;   // UTF-32LE
    text = utf16(b.subarray(2), false); family = "utf-16";
  } else if (b[0] === 0xfe && b[1] === 0xff) { text = utf16(b.subarray(2), true); family = "utf-16"; }
  else if (b[0] === 0x3c && b[1] === 0x00) {
    if (b[2] === 0 && b[3] === 0) return null;   // UTF-32LE without a mark
    text = utf16(b, false); family = "utf-16";
  } else if (b[0] === 0x00 && b[1] === 0x3c) { text = utf16(b, true); family = "utf-16"; }
  else if (b[0] === 0x00) return null;           // UTF-32BE or worse
  else { text = b.toString("utf8"); family = "utf-8"; }
  if (text === null || text.includes("\u0000") || text.includes("\ufffd")) return null;
  if (text.startsWith("<?xml")) {
    const end = text.indexOf("?>");
    if (end < 0) return null;
    const m = /\sencoding\s*=\s*(["'])([^"']*)\1/.exec(text.slice(0, end));
    if (m) {
      const enc = m[2].trim().toLowerCase();
      const ok = family === "utf-8" ? ["utf-8", "utf8", "us-ascii", "ascii"].includes(enc) : ["utf-16", "utf-16le", "utf-16be"].includes(enc);
      if (!ok) return null;
    }
  }
  return text;
}

/** An attribute value with its references resolved, or null when one is undefined or malformed. */
function attrValue(raw: string): string | null {
  if (raw.includes("<")) return null;
  let out = "";
  let pos = 0;
  for (;;) {
    const amp = raw.indexOf("&", pos);
    if (amp < 0) break;
    const semi = raw.indexOf(";", amp + 1);
    if (semi < 0 || semi - amp > 12) return null;
    const ref = raw.slice(amp + 1, semi);
    let ch: string | undefined;
    if (/^#x[0-9a-fA-F]{1,6}$/.test(ref) || /^#[0-9]{1,7}$/.test(ref)) {
      const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!(code > 0 && code <= 0x10ffff)) return null;
      ch = String.fromCodePoint(code);
    } else ch = NAMED[ref];
    if (ch === undefined) return null;
    out += raw.slice(pos, amp) + ch;
    pos = semi + 1;
  }
  // Attribute-value normalisation: each literal tab, CR or LF reads as a space.
  return (out + raw.slice(pos)).replace(/[\t\r\n]/g, " ");
}

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const localName = (qname: string) => qname.slice(qname.indexOf(":") + 1).toLowerCase();

/** The attributes of the start tag whose name begins at `i`, and where the tag ends; null when it is malformed. */
function startTag(xml: string, i: number): { attrs: Map<string, string>; end: number } | null {
  let j = i;
  while (j < xml.length && !isSpace(xml.charCodeAt(j)) && xml[j] !== ">" && xml[j] !== "/") j++;
  if (j === i || /["'<=&]/.test(xml.slice(i, j))) return null;
  const attrs = new Map<string, string>();
  for (;;) {
    while (j < xml.length && isSpace(xml.charCodeAt(j))) j++;
    if (xml[j] === ">") return { attrs, end: j + 1 };
    if (xml[j] === "/" && xml[j + 1] === ">") return { attrs, end: j + 2 };
    const from = j;
    while (j < xml.length && !isSpace(xml.charCodeAt(j)) && xml[j] !== "=" && xml[j] !== ">" && xml[j] !== "/") j++;
    const name = xml.slice(from, j);
    if (!name || /["'<&]/.test(name)) return null;
    while (j < xml.length && isSpace(xml.charCodeAt(j))) j++;
    if (xml[j] !== "=") return null;
    j++;
    while (j < xml.length && isSpace(xml.charCodeAt(j))) j++;
    const q = xml[j];
    if (q !== "\"" && q !== "'") return null;
    const close = xml.indexOf(q, j + 1);
    if (close < 0) return null;
    const value = attrValue(xml.slice(j + 1, close));
    const key = localName(name);
    if (value === null || attrs.has(key)) return null;
    attrs.set(key, value);
    j = close + 1;
  }
}

/** Whether one element's attributes point outside the package. */
function pointsOut(attrs: Map<string, string>): boolean {
  const mode = attrs.get("targetmode");
  if (mode !== undefined && mode.trim().toLowerCase() !== "internal") return true;
  const target = attrs.get("target");
  if (target === undefined) return false;
  const t = target.trim();
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(t) || t.startsWith("//") || t.startsWith("\\") || t.startsWith("/\\");
}

/** Whether a `.rels` part's bytes link outside the deck, or cannot be read well enough to tell (then true). */
export function relsLinksOut(raw: Uint8Array): boolean {
  const xml = decodeXmlBytes(raw);
  if (xml === null) return true;
  let pos = 0;
  for (;;) {
    const lt = xml.indexOf("<", pos);
    if (lt < 0) return false;
    if (xml.startsWith("<!", lt) && !xml.startsWith("<!--", lt) && !xml.startsWith("<![CDATA[", lt)) return true;   // a DOCTYPE: entities or attribute defaults
    const close = xml.startsWith("<?", lt) ? "?>" : xml.startsWith("<!--", lt) ? "-->" : xml.startsWith("<![CDATA[", lt) ? "]]>" : xml.startsWith("</", lt) ? ">" : "";
    if (close) {
      const at = xml.indexOf(close, lt + 2);
      if (at < 0) return true;   // an unterminated declaration, comment or closing tag
      pos = at + close.length;
      continue;
    }
    const tag = startTag(xml, lt + 1);
    if (!tag || pointsOut(tag.attrs)) return true;
    pos = tag.end;
  }
}

/** Whether a ZIP item name is a relationship part, read as OPC maps names (percent-encoded); an undecodable name counts. */
export function isRelsName(name: string): boolean {
  if (/\.rels$/i.test(name)) return true;
  if (!name.includes("%")) return false;
  try { return /\.rels$/i.test(decodeURIComponent(name)); } catch { return true; }
}
