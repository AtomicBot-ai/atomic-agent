import type { Extractor, ExtractResult } from "./extractor-types.js";

/**
 * Text-only PDF extractor backed by pdfjs-dist (Mozilla's library).
 *
 * We use the `legacy` build which ships as standard ESM and requires no
 * worker in Node — pdfjs detects `DOMMatrix` absence and runs synchronously
 * inside the main thread. Bundle size impact in the SEA: ~1.8 MB (worth it
 * for native PDF support without shelling out to poppler).
 *
 * We deliberately skip font rendering and graphics — text is what the LLM
 * needs; images/figures would require an OCR pass which is far out of scope.
 */
export const pdfExtractor: Extractor = async (input) => {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(input.data),
    // Nobody calls disable-font-face in Node; pdfjs handles the missing
    // DOM gracefully. We DO disable the worker to keep things single-thread.
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    // 0 = ERRORS only. Suppresses the cosmetic "standardFontDataUrl not
    // provided" warning — we don't render fonts, just extract glyph runs.
    verbosity: 0,
  }).promise;

  const warnings: string[] = [];
  const totalPages = doc.numPages;
  const { start, end } = clampPageRange(totalPages, input);
  const maxPages = input.maxPages ?? totalPages;
  const separators = input.pageSeparators !== false;

  const extracted: number[] = [];
  const chunks: string[] = [];

  for (let pageNum = start; pageNum <= end; pageNum++) {
    if (extracted.length >= maxPages) break;
    try {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = assembleLines(content.items as PdfTextItem[]);
      if (separators) {
        chunks.push(`--- page ${pageNum} ---\n${pageText}`);
      } else if (pageText.length > 0) {
        chunks.push(pageText);
      }
      extracted.push(pageNum);
    } catch (err) {
      warnings.push(
        `page ${pageNum}: failed to extract (${(err as Error).message})`,
      );
    }
  }

  // Free worker-side state. pdfjs-dist >= 4 supports doc.destroy().
  try {
    await doc.destroy();
  } catch {
    // Best-effort cleanup; never fail the tool over a destroy error.
  }

  const result: ExtractResult = {
    format: "pdf",
    text: chunks.join("\n\n").trim(),
    pageCount: totalPages,
    pagesExtracted: extracted,
    warnings,
  };
  return result;
};

interface PdfTextItem {
  str: string;
  transform?: readonly number[];
  hasEOL?: boolean;
  height?: number;
  width?: number;
}

/**
 * pdfjs returns a flat list of glyph runs; there are no line objects. We
 * reconstruct lines by comparing the Y-component of each run's transform
 * matrix (index 5 in the 2D-affine form `[a, b, c, d, e, f]`). Runs with
 * the same Y land on the same line. Between lines we add `\n`; between
 * whitespace-separated runs on the same line we keep a single space.
 */
function assembleLines(items: PdfTextItem[]): string {
  if (items.length === 0) return "";
  const lines: string[] = [];
  let currentLine = "";
  let lastY: number | null = null;

  for (const item of items) {
    const y = item.transform?.[5] ?? null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 1) {
      lines.push(currentLine.trimEnd());
      currentLine = "";
    }
    currentLine += item.str;
    if (item.hasEOL) {
      lines.push(currentLine.trimEnd());
      currentLine = "";
    }
    lastY = y ?? lastY;
  }
  if (currentLine.length > 0) lines.push(currentLine.trimEnd());
  return lines.filter((l) => l.length > 0).join("\n");
}

function clampPageRange(
  total: number,
  input: Extractor extends (i: infer I) => unknown ? I : never,
): { start: number; end: number } {
  const from = input.pagesFrom ?? 1;
  const to = input.pagesTo ?? total;
  return {
    start: Math.max(1, Math.min(from, total)),
    end: Math.max(1, Math.min(to, total)),
  };
}

/**
 * Dynamic import is intentional: pdfjs-dist is ~1.8 MB and has top-level
 * side effects (globalThis patching). Only load it when we actually need
 * to parse a PDF. Cached in module scope after first call.
 */
let pdfJsModule: typeof import("pdfjs-dist/legacy/build/pdf.mjs") | undefined;
async function loadPdfJs(): Promise<
  typeof import("pdfjs-dist/legacy/build/pdf.mjs")
> {
  if (!pdfJsModule) {
    pdfJsModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfJsModule;
}
