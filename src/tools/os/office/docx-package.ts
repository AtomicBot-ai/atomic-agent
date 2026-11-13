import JSZip from "jszip";

import {
  HEADING_STYLES,
  R_NS,
  STYLES_XML,
  W_NS,
  paragraphXml,
  type DocBlock,
} from "./docx-xml.js";

/**
 * Building and extending `.docx` packages directly (a zip of XML parts),
 * so writing Word needs no Python, pandoc or LibreOffice. `jszip` is
 * already a runtime dependency (the document readers use it).
 */

const CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `</Types>`;

const PACKAGE_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;

const STYLES_REL_TYPE = `${R_NS}/styles`;
const STYLES_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml";

const DOCUMENT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${STYLES_REL_TYPE}" Target="styles.xml"/>` +
  `</Relationships>`;

/** A4 with 2 cm margins: what a fresh Word document in most locales opens with. */
const SECTION =
  `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
  `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>`;

export async function createDocx(blocks: readonly DocBlock[]): Promise<Buffer> {
  const zip = new JSZip();
  const body = blocks.map(paragraphXml).join("");
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", PACKAGE_RELS);
  zip.file("word/_rels/document.xml.rels", DOCUMENT_RELS);
  zip.file("word/styles.xml", STYLES_XML);
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body}${SECTION}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** `word/document.xml` unless the package's root relationship names another part. */
export async function mainDocumentPath(zip: JSZip): Promise<string> {
  const rels = await zip.file("_rels/.rels")?.async("text");
  const match = rels?.match(/<Relationship\b[^>]*Type="[^"]*\/officeDocument"[^>]*>/);
  const target = match?.[0]?.match(/Target="([^"]+)"/)?.[1];
  const path = (target ?? "word/document.xml").replace(/^\//, "");
  if (zip.file(path) === null) {
    throw new Error("not a Word document: the package has no main document part");
  }
  return path;
}

/**
 * Insert `xml` as the last content of the body: before the body-level
 * `<w:sectPr>` (the page setup, which must stay last), or before
 * `</w:body>` when there is none. A `<w:sectPr>` inside a paragraph is a
 * section break, not the body's, and is left alone.
 */
export function insertAtBodyEnd(documentXml: string, xml: string): string {
  const bodyEnd = documentXml.lastIndexOf("</w:body>");
  if (bodyEnd < 0) throw new Error("not a Word document: no <w:body> in the main part");
  const sect = documentXml.lastIndexOf("<w:sectPr", bodyEnd);
  const at =
    sect >= 0 && !documentXml.slice(sect, bodyEnd).includes("</w:p>") ? sect : bodyEnd;
  return documentXml.slice(0, at) + xml + documentXml.slice(at);
}

export async function appendToDocx(
  data: Buffer,
  blocks: readonly DocBlock[],
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(data);
  const main = await mainDocumentPath(zip);
  const documentXml = await zip.file(main)!.async("text");
  zip.file(main, insertAtBodyEnd(documentXml, blocks.map(paragraphXml).join("")));
  if (blocks.some((block) => block.kind.startsWith("heading"))) {
    await ensureHeadingStyles(zip, main);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/**
 * Appended headings name `Heading1`–`Heading3`. A document made by Word
 * has them; one made elsewhere may not, and Word then shows the heading
 * as body text. Missing definitions are added, existing ones are kept as
 * the author styled them.
 */
async function ensureHeadingStyles(zip: JSZip, main: string): Promise<void> {
  const dir = main.includes("/") ? main.slice(0, main.lastIndexOf("/") + 1) : "";
  const relsPath = `${dir}_rels/${main.slice(dir.length)}.rels`;
  const rels = await zip.file(relsPath)?.async("text");
  const styleTarget = rels
    ?.match(new RegExp(`<Relationship\\b[^>]*Type="${escapeRegex(STYLES_REL_TYPE)}"[^>]*>`))?.[0]
    ?.match(/Target="([^"]+)"/)?.[1];
  if (styleTarget !== undefined) {
    const stylesPath = styleTarget.startsWith("/") ? styleTarget.slice(1) : dir + styleTarget;
    const styles = await zip.file(stylesPath)?.async("text");
    if (styles === undefined) return;
    const missing = HEADING_STYLES.filter((style) => !styles.includes(`w:styleId="${style.id}"`));
    if (missing.length === 0) return;
    const end = styles.lastIndexOf("</w:styles>");
    if (end < 0) return;
    zip.file(stylesPath, styles.slice(0, end) + missing.map((s) => s.xml).join("") + styles.slice(end));
    return;
  }
  // No styles part at all: add ours, its relationship and content type.
  const stylesPath = `${dir}styles.xml`;
  if (zip.file(stylesPath) !== null) return;
  zip.file(stylesPath, STYLES_XML);
  const relationship = `<Relationship Id="rIdAtomicStyles" Type="${STYLES_REL_TYPE}" Target="styles.xml"/>`;
  zip.file(
    relsPath,
    rels === undefined
      ? DOCUMENT_RELS
      : rels.replace("</Relationships>", `${relationship}</Relationships>`),
  );
  const types = await zip.file("[Content_Types].xml")?.async("text");
  if (types !== undefined && !types.includes(`PartName="/${stylesPath}"`)) {
    zip.file(
      "[Content_Types].xml",
      types.replace(
        "</Types>",
        `<Override PartName="/${stylesPath}" ContentType="${STYLES_CONTENT_TYPE}"/></Types>`,
      ),
    );
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
