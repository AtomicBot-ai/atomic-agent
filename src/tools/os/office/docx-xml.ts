/**
 * Small WordprocessingML helpers shared by the `.docx` writer and the
 * text replacer: escaping, and turning the tool's plain-text blocks into
 * `<w:p>` elements.
 *
 * A block is one paragraph. `# `, `## ` and `### ` make Heading 1–3,
 * `- ` or `* ` a bullet item and `1. ` a numbered item (two leading
 * spaces per level, as in Markdown), `![alt](picture.png)` alone on a
 * line a picture, and `**bold**` inside the text a bold run. A block
 * whose every line starts and ends with `|` (two lines or more) is a
 * table, its first row the header; a `|---|` separator row is skipped.
 * Nothing else is interpreted: a model writes plain text and gets plain
 * text, so a stray `_` or `|` never turns into formatting it did not ask
 * for. A block with line breaks is split into one paragraph per line.
 */

export type DocBlockKind =
  | "heading1"
  | "heading2"
  | "heading3"
  | "bullet"
  | "numbered"
  | "paragraph"
  | "table"
  | "image";

export interface DocBlock {
  kind: DocBlockKind;
  /** The text; for an image, its alt text. */
  text: string;
  /** List nesting, 0 = top level (bullet and numbered only). */
  level?: number;
  /** The number the line was typed with (`4. Results` → 4), numbered only. */
  start?: number;
  /** A table's cells, header row first, every row the same width. */
  rows?: string[][];
  /** A picture's path as the block wrote it. */
  path?: string;
}

/** Deepest list level Word defines (0-based). */
export const MAX_LIST_LEVEL = 8;
export const MAX_TABLE_ROWS = 200;
export const MAX_TABLE_COLS = 20;

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)]+)\)$/;
const LIST_LINE = /^( *)([-*]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\|?(\s*:?-{3,}:?\s*\|)*\s*:?-{3,}:?\s*\|?$/;

/** The picture paths a block list embeds, as written: what the tool reads from disk. */
export function imagePathsOf(blocks: readonly string[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    for (const line of block.replace(/\r\n?/g, "\n").split("\n")) {
      const path = IMAGE_LINE.exec(line.trim())?.[2]?.trim();
      if (path !== undefined && path.length > 0 && !out.includes(path)) out.push(path);
    }
  }
  return out;
}

function splitTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch === "\\" && inner[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** A Markdown pipe table, or null when the block is not one. */
export function parseTableBlock(block: string): string[][] | null {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) return null;
  if (!lines.every((line) => line.length > 1 && line.startsWith("|") && line.endsWith("|"))) return null;
  const rows = lines.filter((line) => !TABLE_SEPARATOR.test(line)).map(splitTableRow);
  if (rows.length === 0) return null;
  if (rows.length > MAX_TABLE_ROWS) {
    throw new Error(`a table has ${rows.length} rows; at most ${MAX_TABLE_ROWS} per table (use os.fs.xlsx for more)`);
  }
  const width = Math.max(...rows.map((row) => row.length));
  if (width > MAX_TABLE_COLS) throw new Error(`a table has ${width} columns; at most ${MAX_TABLE_COLS}`);
  return rows.map((row) => [...row, ...Array<string>(width - row.length).fill("")]);
}

const HEADING_PREFIX: ReadonlyArray<[string, DocBlockKind]> = [
  ["### ", "heading3"],
  ["## ", "heading2"],
  ["# ", "heading1"],
];

export function parseBlocks(blocks: readonly string[]): DocBlock[] {
  const out: DocBlock[] = [];
  for (const block of blocks) {
    const normalized = block.replace(/\r\n?/g, "\n");
    const rows = parseTableBlock(normalized);
    if (rows !== null) {
      out.push({ kind: "table", text: "", rows });
      continue;
    }
    for (const rawLine of normalized.split("\n")) {
      const line = rawLine.replace(/\s+$/, "");
      out.push(parseLine(line));
    }
  }
  return out;
}

function parseLine(line: string): DocBlock {
  for (const [prefix, kind] of HEADING_PREFIX) {
    if (line.startsWith(prefix)) return { kind, text: line.slice(prefix.length).trim() };
  }
  const image = IMAGE_LINE.exec(line.trim());
  if (image !== null) return { kind: "image", text: image[1]!.trim(), path: image[2]!.trim() };
  const item = LIST_LINE.exec(line.replace(/\t/g, "  "));
  if (item !== null) {
    const level = Math.min(Math.floor(item[1]!.length / 2), MAX_LIST_LEVEL);
    if (item[2] === "-" || item[2] === "*") return { kind: "bullet", text: item[3]!.trim(), level };
    return { kind: "numbered", text: item[3]!.trim(), level, start: Number.parseInt(item[2]!, 10) };
  }
  return { kind: "paragraph", text: line };
}

export function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code = entity.startsWith("#x")
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : "";
      }
    }
  });
}

/** One `<w:r>` per plain or `**bold**` stretch of the text. */
export function runsXml(text: string): string {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((part) => part.length > 0);
  return parts
    .map((part) => {
      const bold = part.length > 4 && part.startsWith("**") && part.endsWith("**");
      const body = bold ? part.slice(2, -2) : part;
      const props = bold ? "<w:rPr><w:b/></w:rPr>" : "";
      return `<w:r>${props}<w:t xml:space="preserve">${escapeXmlText(body)}</w:t></w:r>`;
    })
    .join("");
}

const STYLE_ID: Partial<Record<DocBlockKind, string>> = {
  heading1: "Heading1",
  heading2: "Heading2",
  heading3: "Heading3",
};

/**
 * One paragraph. A list item gets real Word numbering when `numId` (the
 * `w:num` of its list, see `docx-blocks.ts`) is given; without it it
 * falls back to an indented "• " paragraph, which reads the same.
 */
export function paragraphXml(block: DocBlock, numId?: number): string {
  const style = STYLE_ID[block.kind];
  if (style !== undefined) {
    return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${runsXml(block.text)}</w:p>`;
  }
  if ((block.kind === "bullet" || block.kind === "numbered") && numId !== undefined) {
    const level = block.level ?? 0;
    return `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${runsXml(block.text)}</w:p>`;
  }
  if (block.kind === "bullet" || block.kind === "numbered") {
    // No numbering part to point at: an indented "• " keeps the look.
    const left = 720 + 360 * (block.level ?? 0);
    return `<w:p><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr>${runsXml(`• ${block.text}`)}</w:p>`;
  }
  return `<w:p>${runsXml(block.text)}</w:p>`;
}

/** Heading styles the blocks refer to, named the way Word and readers (mammoth) expect. */
export const HEADING_STYLES: ReadonlyArray<{ id: string; xml: string }> = [1, 2, 3].map((level) => {
  const size = [32, 26, 24][level - 1];
  return {
    id: `Heading${level}`,
    xml:
      `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
      `<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
      `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
      `<w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`,
  };
});

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:styles xmlns:w="${W_NS}">` +
  `<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault>` +
  `<w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
  HEADING_STYLES.map((style) => style.xml).join("") +
  `</w:styles>`;
