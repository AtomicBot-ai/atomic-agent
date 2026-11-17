/**
 * Small WordprocessingML helpers shared by the `.docx` writer and the
 * text replacer: escaping, and turning the tool's plain-text blocks into
 * `<w:p>` elements.
 *
 * A block is one paragraph. `# `, `## ` and `### ` make Heading 1–3,
 * `- ` or `* ` a bullet item, and `**bold**` inside the text a bold run.
 * Nothing else is interpreted: a model writes plain text and gets plain
 * text, so a stray `_` or `|` never turns into formatting it did not ask
 * for. A block with line breaks is split into one paragraph per line.
 */

export type DocBlockKind = "heading1" | "heading2" | "heading3" | "bullet" | "paragraph";

export interface DocBlock {
  kind: DocBlockKind;
  text: string;
}

const HEADING_PREFIX: ReadonlyArray<[string, DocBlockKind]> = [
  ["### ", "heading3"],
  ["## ", "heading2"],
  ["# ", "heading1"],
];

export function parseBlocks(blocks: readonly string[]): DocBlock[] {
  const out: DocBlock[] = [];
  for (const block of blocks) {
    for (const rawLine of block.replace(/\r\n?/g, "\n").split("\n")) {
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
  if (line.startsWith("- ") || line.startsWith("* ")) {
    return { kind: "bullet", text: line.slice(2).trim() };
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
function runsXml(text: string): string {
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

export function paragraphXml(block: DocBlock): string {
  const style = STYLE_ID[block.kind];
  if (style !== undefined) {
    return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${runsXml(block.text)}</w:p>`;
  }
  if (block.kind === "bullet") {
    // A real Word list needs a numbering part; an indented "• " keeps the
    // look and reads back as a bullet without one.
    return `<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>${runsXml(`• ${block.text}`)}</w:p>`;
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
