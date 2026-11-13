import JSZip from "jszip";
import { Lexer, type Token, type Tokens } from "marked";

/**
 * Markdown to a Word document (ATO-1054), with no Word, pandoc or
 * LibreOffice on the machine: the smallest OOXML package Word, Pages,
 * LibreOffice and Google Docs all open — `[Content_Types].xml`, the
 * package relationships, `word/document.xml` and the core properties for
 * the title — zipped with JSZip, which the agent already ships.
 *
 * Formatting is direct (bold, size, monospace, indent) rather than named
 * styles, so the package needs no `styles.xml` or `numbering.xml`: list
 * markers are written as text. Links keep their address in brackets after
 * the text instead of a hyperlink relationship.
 */

/** XML 1.0 forbids most control characters; a message can carry them. */
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

function xml(text: string): string {
  return text
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  underline?: boolean;
  color?: string;
  /** Half-points, as Word stores it. */
  size?: number;
}

function run(text: string, style: RunStyle = {}): string {
  if (text.length === 0) return "";
  const pr: string[] = [];
  if (style.code) pr.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>');
  if (style.bold) pr.push("<w:b/>");
  if (style.italic) pr.push("<w:i/>");
  if (style.strike) pr.push("<w:strike/>");
  if (style.color) pr.push(`<w:color w:val="${style.color}"/>`);
  const size = style.size ?? (style.code ? 20 : undefined);
  if (size) pr.push(`<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`);
  if (style.underline) pr.push('<w:u w:val="single"/>');
  const props = pr.length > 0 ? `<w:rPr>${pr.join("")}</w:rPr>` : "";
  // Line breaks inside a run become Word breaks; tabs stay tabs.
  const parts = text.split("\n").map((line) =>
    line.split("\t").map((piece) => `<w:t xml:space="preserve">${xml(piece)}</w:t>`).join("<w:tab/>"),
  );
  return `<w:r>${props}${parts.join("<w:br/>")}</w:r>`;
}

interface ParagraphStyle {
  /** Left indent, twentieths of a point. */
  indent?: number;
  /** Space after, twentieths of a point. */
  after?: number;
  shade?: boolean;
  borderBottom?: boolean;
}

function paragraph(runs: string, style: ParagraphStyle = {}): string {
  const pr: string[] = [];
  if (style.borderBottom) pr.push('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr>');
  if (style.shade) pr.push('<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>');
  pr.push(`<w:spacing w:after="${style.after ?? 120}"/>`);
  if (style.indent) pr.push(`<w:ind w:left="${style.indent}"/>`);
  return `<w:p><w:pPr>${pr.join("")}</w:pPr>${runs}</w:p>`;
}

function inline(tokens: readonly Token[] | undefined, style: RunStyle = {}): string {
  if (!tokens) return "";
  return tokens.map((t) => inlineToken(t, style)).join("");
}

function inlineToken(token: Token, style: RunStyle): string {
  switch (token.type) {
    case "strong":
      return inline((token as Tokens.Strong).tokens, { ...style, bold: true });
    case "em":
      return inline((token as Tokens.Em).tokens, { ...style, italic: true });
    case "del":
      return inline((token as Tokens.Del).tokens, { ...style, strike: true });
    case "codespan":
      return run((token as Tokens.Codespan).text, { ...style, code: true });
    case "br":
      return run("\n", style);
    case "link": {
      const link = token as Tokens.Link;
      const label = inline(link.tokens, { ...style, color: "1F5FBF", underline: true });
      const shown = link.text.trim();
      return shown === link.href.trim() || link.href.startsWith("mailto:")
        ? label
        : `${label}${run(` (${link.href})`, style)}`;
    }
    case "image": {
      const image = token as Tokens.Image;
      return run(`[image: ${image.text || image.href}]`, { ...style, italic: true });
    }
    case "text": {
      const text = token as Tokens.Text;
      return text.tokens && text.tokens.length > 0 ? inline(text.tokens, style) : run(text.text, style);
    }
    case "checkbox":
      // The list item writes its own [ ] / [x] marker.
      return "";
    case "escape":
    case "html":
      return run((token as Tokens.Escape | Tokens.Tag).text, style);
    default:
      return "raw" in token && typeof token.raw === "string" ? run(token.raw, style) : "";
  }
}

const HEADING_SIZE: Record<number, number> = { 1: 36, 2: 28, 3: 24 };

function blocks(tokens: readonly Token[], indent = 0): string[] {
  const out: string[] = [];
  for (const token of tokens) out.push(...block(token, indent));
  return out;
}

function block(token: Token, indent: number): string[] {
  switch (token.type) {
    case "heading": {
      const h = token as Tokens.Heading;
      return [paragraph(inline(h.tokens, { bold: true, size: HEADING_SIZE[h.depth] ?? 22 }), { indent, after: 80 })];
    }
    case "paragraph":
      return [paragraph(inline((token as Tokens.Paragraph).tokens), { indent })];
    case "text": {
      const t = token as Tokens.Text;
      return [paragraph(t.tokens ? inline(t.tokens) : run(t.text), { indent })];
    }
    case "code":
      return [paragraph(run((token as Tokens.Code).text, { code: true }), { indent, shade: true })];
    case "blockquote":
      return blocks((token as Tokens.Blockquote).tokens, indent + 360).map((p) =>
        p.replace("<w:pPr>", '<w:pPr><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="BBBBBB"/></w:pBdr>'),
      );
    case "list": {
      const list = token as Tokens.List;
      const start = typeof list.start === "number" ? list.start : 1;
      const out: string[] = [];
      list.items.forEach((item, i) => {
        const marker = item.task ? (item.checked ? "[x] " : "[ ] ") : list.ordered ? `${start + i}. ` : "• ";
        const inner = blocks(item.tokens, indent + 360);
        if (inner.length === 0) inner.push(paragraph("", { indent: indent + 360 }));
        // The marker goes in front of the item's first paragraph.
        inner[0] = (inner[0] ?? "").replace(/(<\/w:pPr>)/, `$1${run(marker)}`);
        out.push(...inner);
      });
      return out;
    }
    case "table":
      return [table(token as Tokens.Table), paragraph("", { after: 0 })];
    case "hr":
      return [paragraph("", { borderBottom: true })];
    case "html":
      return [paragraph(run((token as Tokens.HTML).text.trimEnd()), { indent })];
    case "space":
    case "def":
    case "checkbox":
      return [];
    default:
      return "raw" in token && typeof token.raw === "string" && token.raw.trim()
        ? [paragraph(run(token.raw.trim()), { indent })]
        : [];
  }
}

function table(t: Tokens.Table): string {
  const border = '<w:top w:val="single" w:sz="4" w:color="BBBBBB"/><w:left w:val="single" w:sz="4" w:color="BBBBBB"/><w:bottom w:val="single" w:sz="4" w:color="BBBBBB"/><w:right w:val="single" w:sz="4" w:color="BBBBBB"/><w:insideH w:val="single" w:sz="4" w:color="BBBBBB"/><w:insideV w:val="single" w:sz="4" w:color="BBBBBB"/>';
  const cell = (c: Tokens.TableCell, header: boolean): string =>
    `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph(inline(c.tokens, header ? { bold: true } : {}), { after: 0 })}</w:tc>`;
  const rows = [
    `<w:tr>${t.header.map((c) => cell(c, true)).join("")}</w:tr>`,
    ...t.rows.map((r) => `<w:tr>${r.map((c) => cell(c, false)).join("")}</w:tr>`),
  ];
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border}</w:tblBorders></w:tblPr><w:tblGrid>${t.header
    .map(() => "<w:gridCol/>")
    .join("")}</w:tblGrid>${rows.join("")}</w:tbl>`;
}

/** `word/document.xml` for `markdown`. Exported for tests. */
export function markdownToDocumentXml(markdown: string): string {
  const body = blocks(Lexer.lex(markdown)).join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body>` +
    "</w:document>"
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  "</Types>";

const PACKAGE_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  "</Relationships>";

function coreProps(title: string, now: number): string {
  const when = new Date(Number.isFinite(now) ? now : Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xml(title)}</dc:title><dc:creator>Atomic Agent</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created>` +
    "</cp:coreProperties>"
  );
}

/** A `.docx` file holding `markdown`, titled `title`. */
export async function renderMarkdownDocx(
  markdown: string,
  title: string,
  now: number = Date.now(),
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", PACKAGE_RELS);
  zip.file("docProps/core.xml", coreProps(title, now));
  zip.file("word/document.xml", markdownToDocumentXml(markdown));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
