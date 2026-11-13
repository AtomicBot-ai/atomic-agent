/**
 * Detects PDF pages that have no usable text layer (scans, photos of
 * receipts, image-only exports) so `os.fs.read_document` can tell the model
 * plainly that OCR is needed instead of handing back an empty string that
 * reads like "this document is blank" (ATO-681).
 *
 * Pure functions only: the PDF extractor feeds in the text it already
 * assembled per page, this module decides and phrases. No OCR happens here.
 */

/**
 * A page counts as "no text layer" when it carries fewer than this many
 * non-whitespace characters. Scans often keep a stray page number, a
 * scanner stamp or a few glyphs from a header; a real text page has far
 * more. Kept low on purpose so a short but genuine page (a title page, a
 * one-line signature page) is not reported as a scan.
 */
export const MIN_TEXT_CHARS_PER_PAGE = 16;

/** How many page numbers the notice lists before it summarises the rest. */
const MAX_LISTED_PAGES = 20;

export interface PageText {
  /** 1-indexed page number in the source document. */
  page: number;
  text: string;
}

export type TextLayerStatus =
  /** Every checked page has a text layer. */
  | "ok"
  /** Some checked pages have no text layer (mixed scan + digital PDF). */
  | "partial"
  /** No checked page has a text layer: the PDF looks scanned. */
  | "scanned";

export interface TextLayerAssessment {
  status: TextLayerStatus;
  /** How many pages were looked at (the extracted range, not the whole file). */
  pagesChecked: number;
  /** 1-indexed page numbers that have no / near-no text layer. */
  pagesWithoutText: number[];
  /** True when at least one checked page needs OCR to be read. */
  ocrNeeded: boolean;
}

export function countTextChars(text: string): number {
  return text.replace(/\s+/g, "").length;
}

export function hasTextLayer(
  text: string,
  minChars: number = MIN_TEXT_CHARS_PER_PAGE,
): boolean {
  return countTextChars(text) >= minChars;
}

export function assessTextLayer(
  pages: readonly PageText[],
  minChars: number = MIN_TEXT_CHARS_PER_PAGE,
): TextLayerAssessment {
  const pagesWithoutText = pages
    .filter((p) => !hasTextLayer(p.text, minChars))
    .map((p) => p.page);
  const pagesChecked = pages.length;
  let status: TextLayerStatus = "ok";
  if (pagesChecked > 0 && pagesWithoutText.length === pagesChecked) {
    status = "scanned";
  } else if (pagesWithoutText.length > 0) {
    status = "partial";
  }
  return {
    status,
    pagesChecked,
    pagesWithoutText,
    ocrNeeded: pagesWithoutText.length > 0,
  };
}

/**
 * The notice the model reads. Returns `undefined` when nothing is missing.
 * It names the problem, the pages, and the next steps in the order the
 * agent can actually take them today: look at the pages with the vision
 * tool when the model supports images, otherwise add a text layer with the
 * `pdf` skill's `ocrmypdf` route. It never claims OCR ran.
 */
export function buildTextLayerNotice(
  assessment: TextLayerAssessment,
): string | undefined {
  if (!assessment.ocrNeeded) return undefined;
  const missing = assessment.pagesWithoutText.length;
  const headline =
    assessment.status === "scanned"
      ? `This PDF looks scanned: ${missing} of ${assessment.pagesChecked} pages have no text layer, so no text could be extracted. OCR is needed to read it.`
      : `Part of this PDF looks scanned: ${missing} of ${assessment.pagesChecked} pages have no text layer (pages ${formatPageList(assessment.pagesWithoutText)}). Text from those pages is missing below; OCR is needed to read them.`;
  return [
    headline,
    "Next steps:",
    "1. If vision.describe is available (the current model accepts images): render the pages to PNG with the pdf skill (`pdftoppm -png -r 150`) and pass the images to vision.describe.",
    "2. Otherwise add a text layer with the pdf skill (`ocrmypdf --skip-text in.pdf out_ocr.pdf`, add `-l rus+eng` for Russian) and call os.fs.read_document again on the new file.",
    "Ask the user before installing anything; do not tell them the document is empty.",
  ].join("\n");
}

function formatPageList(pages: readonly number[]): string {
  if (pages.length <= MAX_LISTED_PAGES) return pages.join(", ");
  const shown = pages.slice(0, MAX_LISTED_PAGES).join(", ");
  return `${shown} and ${pages.length - MAX_LISTED_PAGES} more`;
}

/**
 * Join extracted pages into the tool output and build the notice. A fully
 * scanned PDF yields nothing but page dividers, so the notice leads the
 * text there; for a partly scanned one it travels as a warning only, so
 * the real text is not pushed down.
 */
export function renderPdfPages(
  pages: readonly PageText[],
  assessment: TextLayerAssessment,
  separators: boolean,
): { text: string; notice?: string } {
  const chunks: string[] = [];
  for (const { page, text } of pages) {
    if (separators) chunks.push(`--- page ${page} ---\n${text}`);
    else if (text.length > 0) chunks.push(text);
  }
  const text = chunks.join("\n\n").trim();
  const notice = buildTextLayerNotice(assessment);
  if (!notice) return { text };
  if (assessment.status !== "scanned") return { text, notice };
  return { text: text.length > 0 ? `${notice}\n\n${text}` : notice, notice };
}
