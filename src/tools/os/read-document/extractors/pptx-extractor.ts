import type { Extractor } from "./extractor-types.js";
import {
  joinExtracted,
  openZip,
  parseXml,
  readZipText,
} from "./zip-xml-helpers.js";

/**
 * PPTX extractor: an OOXML Zip with slides under `ppt/slides/slideN.xml`.
 * Each slide contains `a:p` paragraphs with `a:r` runs holding `a:t` text.
 *
 * We iterate slides in numeric order (not Zip order) so slide N is the
 * Nth slide on screen. Separators are `--- slide N ---` matching the PDF
 * convention. `pagesFrom/pagesTo/maxPages` work exactly like in PDF.
 */
export const pptxExtractor: Extractor = async (input) => {
  const warnings: string[] = [];
  const zip = await openZip(input.data);
  const slidePaths = listSlides(zip);
  if (slidePaths.length === 0) {
    return { format: "pptx", text: "", slideCount: 0, warnings: ["no slides found"] };
  }
  const slideCount = slidePaths.length;
  const start = input.pagesFrom ?? 1;
  const end = input.pagesTo ?? slideCount;
  const maxPages = input.maxPages ?? slideCount;
  const separators = input.pageSeparators !== false;

  const extracted: number[] = [];
  const chunks: string[] = [];

  for (let n = start; n <= end; n++) {
    if (extracted.length >= maxPages) break;
    const path: string | undefined = slidePaths[n - 1];
    if (!path) continue;
    try {
      const xml = await readZipText(zip, path);
      if (!xml) continue;
      const text = extractSlideText(xml);
      if (separators) {
        chunks.push(`--- slide ${n} ---\n${text}`);
      } else if (text.length > 0) {
        chunks.push(text);
      }
      extracted.push(n);
    } catch (err) {
      warnings.push(
        `slide ${n}: failed to parse (${(err as Error).message})`,
      );
    }
  }

  return {
    format: "pptx",
    text: joinExtracted(chunks).replace(/\n{2,}---/g, "\n\n---"),
    slideCount,
    pagesExtracted: extracted,
    warnings,
  };
};

function listSlides(zip: Awaited<ReturnType<typeof openZip>>): string[] {
  const paths: string[] = [];
  zip.forEach((relativePath) => {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(relativePath)) {
      paths.push(relativePath);
    }
  });
  paths.sort((a, b) => slideNumber(a) - slideNumber(b));
  return paths;
}

function slideNumber(path: string): number {
  const m = /slide(\d+)\.xml$/.exec(path);
  return m?.[1] ? parseInt(m[1], 10) : 0;
}

/**
 * Slide XML uses `a:p` (paragraph) nodes containing `a:r` (run) nodes with
 * `a:t` (text) leaves. We walk the preserved-order tree and emit a newline
 * after each paragraph so bullet points and lines stay distinguishable.
 */
function extractSlideText(xml: string): string {
  const tree = parseXml(xml);
  const out: string[] = [];
  visit(tree, out);
  return out.join("").trim();
}

function visit(nodes: ReturnType<typeof parseXml>, out: string[]): void {
  for (const item of nodes) {
    const tag = Object.keys(item).find((k) => k !== ":@");
    if (!tag) continue;
    const children = item[tag] as unknown;
    if (tag === "a:t") {
      if (Array.isArray(children)) {
        for (const ch of children) {
          const text = (ch as { "#text"?: unknown })["#text"];
          if (typeof text === "string") out.push(text);
          else if (typeof text === "number") out.push(String(text));
        }
      }
      continue;
    }
    if (Array.isArray(children)) {
      visit(children as ReturnType<typeof parseXml>, out);
    }
    if (tag === "a:p") out.push("\n");
  }
}
