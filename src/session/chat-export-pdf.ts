import { deflateSync } from "node:zlib";

import { Lexer, type Token, type Tokens } from "marked";

/**
 * Markdown to a PDF (ATO-1054) with Node alone: no browser, no PDF
 * library. Text pages in the four fonts every PDF reader carries
 * (Helvetica, Helvetica-Bold, Helvetica-Oblique, Courier), so nothing is
 * embedded and the file stays small.
 *
 * The limit that comes with that: the standard fonts use WinAnsi
 * encoding, which covers English and Western European text. Anything
 * else is transliterated where a plain spelling exists (Cyrillic, curly
 * quotes are native, arrows become `->`, accented letters outside
 * Latin-1 lose the accent) and shown as `?` otherwise (CJK, emoji). When
 * that happens the document ends with a note saying how many characters
 * changed and that the Markdown and Word exports keep them all.
 */

type FontKey = "R" | "B" | "I" | "M";

const FONT_RESOURCE: Record<FontKey, string> = { R: "F1", B: "F2", I: "F3", M: "F4" };
const FONT_BASE: Record<FontKey, string> = {
  R: "Helvetica",
  B: "Helvetica-Bold",
  I: "Helvetica-Oblique",
  M: "Courier",
};

/** Advance widths (1/1000 em) of characters 32..126, from the Adobe AFM files. */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  ...Array<number>(10).fill(556),
  278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584,
];
const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  ...Array<number>(10).fill(556),
  333, 333, 584, 584, 584, 611, 975,
  722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  333, 278, 333, 584, 556, 333,
  556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500,
  389, 280, 389, 584,
];

/** Width of one encoded character (code 0..255) in 1/1000 em. */
function charWidth(code: number, font: FontKey): number {
  if (font === "M") return 600;
  const table = font === "B" ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  if (code >= 32 && code <= 126) return table[code - 32] ?? 556;
  if (code === 0x95) return 350;
  // Latin-1 letters and signs: a little wider than most, so a line wraps
  // early rather than running past the margin.
  return font === "B" ? 667 : 611;
}

function textWidth(text: string, font: FontKey, size: number): number {
  let w = 0;
  for (let i = 0; i < text.length; i += 1) w += charWidth(text.charCodeAt(i), font);
  return (w * size) / 1000;
}

/** The 0x80..0x9F block of WinAnsi (cp1252), which differs from Latin-1. */
const WIN_ANSI_HIGH: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86,
  "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c,
  "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95,
  "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b,
  "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

/** Plain spellings for characters the standard fonts lack. */
const TRANSLIT: Record<string, string> = {
  // Russian, Ukrainian, Belarusian (lower case; upper case is derived).
  "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e",
  "ё": "e", "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k",
  "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r",
  "с": "s", "т": "t", "у": "u", "ф": "f", "х": "kh", "ц": "ts",
  "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "", "ы": "y", "ь": "",
  "э": "e", "ю": "yu", "я": "ya", "і": "i", "ї": "yi", "є": "ye",
  "ґ": "g", "ў": "u",
  // Letters NFKD does not split into base plus accent.
  "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ı": "i", "ħ": "h", "Ħ": "H",
  // Symbols that show up in replies.
  "→": "->", "←": "<-", "↔": "<->", "⇒": "=>", "≤": "<=", "≥": ">=",
  "≠": "!=", "≈": "~", "−": "-", "‑": "-", "‐": "-", "′": "'", "″": '"',
  "✓": "+", "✔": "+", "✅": "+", "✗": "x", "✘": "x", "❌": "x",
  "─": "-", "│": "|", " ": " ", " ": " ", " ": " ", " ": " ",
};

/** Characters that carry no ink: dropped without counting as a change. */
const INVISIBLE = /[​-‍⁠︀-️﻿]/;

/** Unicode text to WinAnsi bytes (as a latin1 string), counting what changed. */
class WinAnsiEncoder {
  /** Characters transliterated or replaced with `?`. */
  changed = 0;

  encode(text: string): string {
    let out = "";
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      if (code === 9) out += "    ";
      else if (code < 32 || code === 127) continue;
      else if (code < 127 || (code >= 0xa0 && code <= 0xff)) out += ch;
      else if (WIN_ANSI_HIGH[ch] !== undefined) out += String.fromCharCode(WIN_ANSI_HIGH[ch] ?? 63);
      else if (INVISIBLE.test(ch)) continue;
      else {
        this.changed += 1;
        out += this.fallback(ch);
      }
    }
    return out;
  }

  private fallback(ch: string): string {
    const lower = ch.toLowerCase();
    const mapped = TRANSLIT[ch] ?? TRANSLIT[lower];
    if (mapped !== undefined) {
      return ch !== lower && mapped.length > 0 ? mapped[0]!.toUpperCase() + mapped.slice(1) : mapped;
    }
    // Accented letters: the base letter when it is one the font has.
    const base = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    if (base.length > 0 && [...base].every((c) => (c.codePointAt(0) ?? 0) < 0x100 && (c.codePointAt(0) ?? 0) >= 32)) {
      return base;
    }
    return "?";
  }
}

interface Piece {
  text: string;
  font: FontKey;
}

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;
const BOTTOM = MARGIN + 14;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const BODY_SIZE = 10.5;
const CODE_SIZE = 9;
const INDENT = 16;

function num(n: number): string {
  return Number(n.toFixed(2)).toString();
}

function pdfString(latin1: string): string {
  return `(${latin1.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

interface LineOptions {
  indent?: number;
  gray?: boolean;
  /** Draw a quote bar left of the line. */
  bar?: boolean;
  /** Shade the line (code). */
  shade?: boolean;
  /** Drawn in the hanging indent left of the first line (a list marker). */
  marker?: string;
}

/** Lays lines top to bottom, starting a page when one is full. */
class PageWriter {
  readonly pages: string[][] = [];
  private ops: string[] = [];
  private y = 0;
  private atTop = true;

  constructor() {
    this.newPage();
  }

  private newPage(): void {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = PAGE_H - MARGIN;
    this.atTop = true;
  }

  gap(h: number): void {
    if (!this.atTop) this.y -= h;
  }

  line(pieces: readonly Piece[], size: number, options: LineOptions = {}): void {
    const lead = size * 1.4;
    if (this.y - lead < BOTTOM) this.newPage();
    const x = MARGIN + (options.indent ?? 0);
    const baseline = this.y - size;
    if (options.shade) {
      this.ops.push(`0.95 g ${num(x - 4)} ${num(this.y - lead)} ${num(CONTENT_W - (options.indent ?? 0) + 8)} ${num(lead)} re f`);
    }
    if (options.bar) {
      this.ops.push(`0.75 G 1.5 w ${num(x - 9)} ${num(this.y)} m ${num(x - 9)} ${num(this.y - lead)} l S`);
    }
    const color = options.gray ? "0.33 g" : "0 g";
    const runs: string[] = [];
    let font: FontKey | null = null;
    for (const piece of pieces) {
      if (piece.text.length === 0) continue;
      if (piece.font !== font) {
        runs.push(`/${FONT_RESOURCE[piece.font]} ${num(size)} Tf`);
        font = piece.font;
      }
      runs.push(`${pdfString(piece.text)} Tj`);
    }
    if (options.marker) {
      // Right-aligned in the hanging indent, so `[x]` and `10.` fit too.
      const mx = x - 5 - textWidth(options.marker, "R", size);
      this.ops.push(`BT ${color} /F1 ${num(size)} Tf ${num(mx)} ${num(baseline)} Td ${pdfString(options.marker)} Tj ET`);
    }
    if (runs.length > 0) this.ops.push(`BT ${color} ${num(x)} ${num(baseline)} Td ${runs.join(" ")} ET`);
    this.y -= lead;
    this.atTop = false;
  }

  rule(): void {
    if (this.y - 12 < BOTTOM) this.newPage();
    const y = this.y - 6;
    this.ops.push(`0.75 G 0.5 w ${num(MARGIN)} ${num(y)} m ${num(PAGE_W - MARGIN)} ${num(y)} l S`);
    this.y -= 12;
    this.atTop = false;
  }
}

/** Split pieces into lines no wider than `width`; runs of spaces collapse to one. */
function wrap(pieces: readonly Piece[], width: number, size: number): Piece[][] {
  const lines: Piece[][] = [];
  let line: Piece[] = [];
  let w = 0;
  let space: FontKey | null = null;
  const add = (text: string, font: FontKey): void => {
    const last = line[line.length - 1];
    if (last && last.font === font) last.text += text;
    else line.push({ text, font });
  };
  const breakLine = (): void => {
    lines.push(line);
    line = [];
    w = 0;
    space = null;
  };
  for (const piece of pieces) {
    for (const token of piece.text.match(/\n| +|[^ \n]+/g) ?? []) {
      if (token === "\n") {
        breakLine();
        continue;
      }
      if (token.startsWith(" ")) {
        if (line.length > 0) space = piece.font;
        continue;
      }
      const sw = space ? textWidth(" ", space, size) : 0;
      const ww = textWidth(token, piece.font, size);
      if (line.length > 0 && w + sw + ww > width) breakLine();
      if (ww <= width) {
        if (space && line.length > 0) add(" ", space);
        add(token, piece.font);
        w += (line.length > 0 && space ? sw : 0) + ww;
        space = null;
        continue;
      }
      // A word wider than the line (a long URL, a hash): cut it by characters.
      if (space && line.length > 0) {
        add(" ", space);
        w += sw;
      }
      space = null;
      for (const ch of token) {
        const cw = textWidth(ch, piece.font, size);
        if (line.length > 0 && w + cw > width) breakLine();
        add(ch, piece.font);
        w += cw;
      }
    }
  }
  if (line.length > 0 || lines.length === 0) lines.push(line);
  return lines;
}

class PdfLayout {
  readonly writer = new PageWriter();

  constructor(private readonly enc: WinAnsiEncoder) {}

  private inline(tokens: readonly Token[] | undefined, font: FontKey, out: Piece[]): Piece[] {
    for (const token of tokens ?? []) this.inlineToken(token, font, out);
    return out;
  }

  private piece(raw: string, font: FontKey, out: Piece[]): void {
    const text = this.enc.encode(raw);
    if (text.length > 0) out.push({ text, font });
  }

  private inlineToken(token: Token, font: FontKey, out: Piece[]): void {
    switch (token.type) {
      case "strong":
        this.inline((token as Tokens.Strong).tokens, font === "M" ? "M" : "B", out);
        return;
      case "em":
        this.inline((token as Tokens.Em).tokens, font === "R" ? "I" : font, out);
        return;
      case "del":
        this.inline((token as Tokens.Del).tokens, font, out);
        return;
      case "codespan":
        this.piece((token as Tokens.Codespan).text, "M", out);
        return;
      case "br":
        out.push({ text: "\n", font });
        return;
      case "link": {
        const link = token as Tokens.Link;
        this.inline(link.tokens, font, out);
        if (link.text.trim() !== link.href.trim() && !link.href.startsWith("mailto:")) {
          this.piece(` (${link.href})`, font, out);
        }
        return;
      }
      case "image": {
        const image = token as Tokens.Image;
        this.piece(`[image: ${image.text || image.href}]`, "I", out);
        return;
      }
      case "text": {
        const text = token as Tokens.Text;
        if (text.tokens && text.tokens.length > 0) this.inline(text.tokens, font, out);
        else this.piece(text.text.replace(/\s*\n\s*/g, " "), font, out);
        return;
      }
      case "checkbox":
        return;
      case "escape":
      case "html":
        this.piece((token as Tokens.Escape | Tokens.Tag).text, font, out);
        return;
      default:
        if ("raw" in token && typeof token.raw === "string") this.piece(token.raw, font, out);
    }
  }

  private paragraph(pieces: readonly Piece[], size: number, options: LineOptions, after: number): void {
    const indent = options.indent ?? 0;
    wrap(pieces, CONTENT_W - indent, size).forEach((line, i) => {
      this.writer.line(line, size, i === 0 ? options : { ...options, marker: undefined });
    });
    this.writer.gap(after);
  }

  /** A list marker in `options` goes on the first block only. */
  blocks(tokens: readonly Token[], options: LineOptions = {}, tight = false): void {
    tokens.forEach((token, i) => this.block(token, i === 0 ? options : { ...options, marker: undefined }, tight));
  }

  private block(token: Token, options: LineOptions, tight: boolean): void {
    const after = tight ? 2 : 6;
    switch (token.type) {
      case "heading": {
        const h = token as Tokens.Heading;
        const size = h.depth === 1 ? 18 : h.depth === 2 ? 12 : 11;
        this.writer.gap(h.depth === 2 ? 10 : 6);
        this.paragraph(this.inline(h.tokens, "B", []), size, { ...options, gray: h.depth === 2 || options.gray }, 4);
        return;
      }
      case "paragraph":
        this.paragraph(this.inline((token as Tokens.Paragraph).tokens, "R", []), BODY_SIZE, options, after);
        return;
      case "text": {
        const t = token as Tokens.Text;
        const pieces = t.tokens ? this.inline(t.tokens, "R", []) : [];
        if (!t.tokens) this.piece(t.text, "R", pieces);
        this.paragraph(pieces, BODY_SIZE, options, after);
        return;
      }
      case "code": {
        const indent = (options.indent ?? 0) + 8;
        const perLine = Math.max(1, Math.floor((CONTENT_W - indent) / (CODE_SIZE * 0.6)));
        let marker = options.marker;
        for (const raw of (token as Tokens.Code).text.split("\n")) {
          const text = this.enc.encode(raw);
          const chunks = text.length === 0 ? [""] : (text.match(new RegExp(`.{1,${perLine}}`, "g")) ?? [""]);
          for (const chunk of chunks) {
            this.writer.line([{ text: chunk, font: "M" }], CODE_SIZE, { ...options, indent, shade: true, marker });
            marker = undefined;
          }
        }
        this.writer.gap(after + 2);
        return;
      }
      case "blockquote":
        this.blocks((token as Tokens.Blockquote).tokens, {
          ...options,
          indent: (options.indent ?? 0) + 14,
          gray: true,
          bar: true,
        });
        return;
      case "list": {
        const list = token as Tokens.List;
        const start = typeof list.start === "number" ? list.start : 1;
        const indent = (options.indent ?? 0) + INDENT;
        list.items.forEach((item, i) => {
          const marker = this.enc.encode(
            item.task ? (item.checked ? "[x]" : "[ ]") : list.ordered ? `${start + i}.` : "•",
          );
          const inner = item.tokens.filter((t) => t.type !== "space" && t.type !== "checkbox");
          if (inner.length === 0) {
            this.writer.line([], BODY_SIZE, { ...options, indent, marker });
            return;
          }
          inner.forEach((t, j) => this.block(t, { ...options, indent, marker: j === 0 ? marker : undefined }, !list.loose));
        });
        this.writer.gap(4);
        return;
      }
      case "table": {
        const table = token as Tokens.Table;
        const row = (cells: readonly Tokens.TableCell[], font: FontKey): Piece[] => {
          const out: Piece[] = [];
          cells.forEach((cell, i) => {
            if (i > 0) out.push({ text: " | ", font: "R" });
            this.inline(cell.tokens, font, out);
          });
          return out;
        };
        this.paragraph(row(table.header, "B"), 9.5, options, 2);
        for (const r of table.rows) this.paragraph(row(r, "R"), 9.5, options, 2);
        this.writer.gap(4);
        return;
      }
      case "hr":
        this.writer.rule();
        return;
      case "html": {
        const pieces: Piece[] = [];
        this.piece((token as Tokens.HTML).text.trimEnd(), "R", pieces);
        this.paragraph(pieces, BODY_SIZE, options, after);
        return;
      }
      case "space":
      case "def":
      case "checkbox":
        return;
      default:
        if ("raw" in token && typeof token.raw === "string" && token.raw.trim()) {
          const pieces: Piece[] = [];
          this.piece(token.raw.trim(), "R", pieces);
          this.paragraph(pieces, BODY_SIZE, options, after);
        }
    }
  }

  /** The closing note when characters had to change. */
  note(changed: number): void {
    const text =
      `Note: this PDF uses the standard PDF fonts, which cover English and Western European text only. ` +
      `${changed} character${changed === 1 ? " was" : "s were"} transliterated or shown as "?". ` +
      `The Markdown and Word exports keep every character.`;
    this.writer.gap(10);
    this.paragraph([{ text, font: "I" }], 9, { gray: true }, 0);
  }
}

/** `<FEFF...>`: a PDF text string that keeps any character (title metadata). */
function utf16Hex(text: string): string {
  let hex = "FEFF";
  for (let i = 0; i < text.length; i += 1) hex += text.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return `<${hex}>`;
}

function pdfDate(ms: number): string {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  return `D:${d.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;
}

function footer(page: number, total: number): string {
  const text = `Page ${page} of ${total}`;
  const x = (PAGE_W - textWidth(text, "R", 8)) / 2;
  return `BT 0.5 g /F1 8 Tf ${num(x)} ${num(MARGIN - 26)} Td ${pdfString(text)} Tj ET`;
}

/** The file: objects, cross-reference table and trailer, every offset exact. */
function serialize(pages: readonly string[][], title: string, now: number): Buffer {
  // 1 catalog, 2 page tree, 3-6 fonts, 7 info, then a page and its content per page.
  const fonts: FontKey[] = ["R", "B", "I", "M"];
  const pageObj = (i: number): number => 8 + i * 2;
  const bodies: Array<string | Buffer> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    ...fonts.map((f) => `<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_BASE[f]} /Encoding /WinAnsiEncoding >>`),
    `<< /Title ${utf16Hex(title)} /Producer (Atomic Agent) /Creator (Atomic Agent) /CreationDate (${pdfDate(now)}) >>`,
  ];
  const fontDict = fonts.map((f, i) => `/${FONT_RESOURCE[f]} ${3 + i} 0 R`).join(" ");
  pages.forEach((ops, i) => {
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PAGE_W)} ${num(PAGE_H)}] ` +
        `/Resources << /Font << ${fontDict} >> >> /Contents ${pageObj(i) + 1} 0 R >>`,
    );
    const data = deflateSync(Buffer.from([...ops, footer(i + 1, pages.length)].join("\n"), "latin1"));
    bodies.push(
      Buffer.concat([
        Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
        data,
        Buffer.from("\nendstream", "latin1"),
      ]),
    );
  });

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%âãÏÓ\n", "latin1")];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, "latin1"),
      typeof body === "string" ? Buffer.from(body, "latin1") : body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    offsets.push(offset);
    chunks.push(chunk);
    offset += chunk.length;
  });
  const xref =
    `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}

/** A `.pdf` file holding `markdown`, titled `title`. */
export function renderMarkdownPdf(markdown: string, title: string, now: number = Date.now()): Buffer {
  const enc = new WinAnsiEncoder();
  const layout = new PdfLayout(enc);
  layout.blocks(Lexer.lex(markdown));
  if (enc.changed > 0) layout.note(enc.changed);
  return serialize(layout.writer.pages, title, now);
}

/** Exported for tests: the encoder on its own. */
export function encodeWinAnsi(text: string): { text: string; changed: number } {
  const enc = new WinAnsiEncoder();
  const out = enc.encode(text);
  return { text: out, changed: enc.changed };
}
