import type { Extractor } from "./extractor-types.js";
import {
  joinExtracted,
  nodeChildren,
  nodeTag,
  odfInlineText,
  openZip,
  parseXmlRaw,
  readZipText,
  type XmlNode,
} from "./zip-xml-helpers.js";

/**
 * ODP (LibreOffice Impress) extractor. Slides are `draw:page` elements in
 * `content.xml`; their text lives in `text:p` / `text:h` paragraphs inside
 * frames, text boxes, lists and tables. Output and paging mirror the PPTX
 * extractor: `--- slide N ---` separators and `pagesFrom`/`pagesTo`/
 * `maxPages` over slide numbers. Speaker notes (`presentation:notes`) are
 * left out, as in PPTX.
 */
export const odpExtractor: Extractor = async (input) => {
  const warnings: string[] = [];
  const zip = await openZip(input.data);
  const contentXml = await readZipText(zip, "content.xml");
  if (!contentXml) {
    return { format: "odp", text: "", slideCount: 0, warnings: ["content.xml missing"] };
  }
  const pages: XmlNode[] = [];
  collectPages(parseXmlRaw(contentXml), pages);
  const slideCount = pages.length;
  if (slideCount === 0) {
    return { format: "odp", text: "", slideCount: 0, warnings: ["no slides found"] };
  }

  const start = Math.max(1, input.pagesFrom ?? 1);
  const end = Math.min(slideCount, input.pagesTo ?? slideCount);
  const maxPages = input.maxPages ?? slideCount;
  const separators = input.pageSeparators !== false;

  const chunks: string[] = [];
  const extracted: number[] = [];
  for (let n = start; n <= end; n++) {
    if (extracted.length >= maxPages) break;
    const page = pages[n - 1];
    if (!page) continue;
    const lines: string[] = [];
    collectSlideText(nodeChildren(page, "draw:page"), lines);
    const text = lines.join("\n").trim();
    if (separators) chunks.push(`--- slide ${n} ---\n${text}`);
    else if (text.length > 0) chunks.push(text);
    extracted.push(n);
  }
  if (extracted.length < end - start + 1) {
    warnings.push(
      `stopped at maxPages=${maxPages}; slides ${start + extracted.length}-${end} not read (use pagesFrom)`,
    );
  }

  return {
    format: "odp",
    text: joinExtracted(chunks.map((c) => `${c}\n\n`)),
    slideCount,
    pagesExtracted: extracted,
    warnings,
  };
};

function collectPages(nodes: XmlNode[], out: XmlNode[]): void {
  for (const item of nodes) {
    const tag = nodeTag(item);
    if (!tag || tag === "#text") continue;
    if (tag === "draw:page") {
      out.push(item);
      continue;
    }
    collectPages(nodeChildren(item, tag), out);
  }
}

function collectSlideText(nodes: XmlNode[], out: string[]): void {
  for (const item of nodes) {
    const tag = nodeTag(item);
    if (!tag || tag === "#text") continue;
    if (tag === "presentation:notes" || tag === "office:annotation") continue;
    if (tag === "text:p" || tag === "text:h") {
      const text = odfInlineText(nodeChildren(item, tag)).trim();
      if (text.length > 0) out.push(text);
      continue;
    }
    if (tag === "table:table-row") {
      const cells: string[] = [];
      for (const cell of nodeChildren(item, tag)) {
        const cellTag = nodeTag(cell);
        if (cellTag !== "table:table-cell") continue;
        const inner: string[] = [];
        collectSlideText(nodeChildren(cell, cellTag), inner);
        cells.push(inner.join(" "));
      }
      if (cells.some((c) => c.length > 0)) out.push(cells.join(" | "));
      continue;
    }
    collectSlideText(nodeChildren(item, tag), out);
  }
}
