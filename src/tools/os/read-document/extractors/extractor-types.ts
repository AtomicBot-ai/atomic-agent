/**
 * Shared contract for every document extractor. A concrete extractor reads
 * a buffer, produces plain text with optional lightweight structure
 * markers (headings, page separators) and a metadata bag. The dispatcher
 * (`read-document.ts`) owns the file I/O and user-facing parameters; this
 * keeps extractors pure and easy to test.
 */

/**
 * The closed set of formats the dispatcher accepts, as a value so that the
 * runtime validator, the error message that lists the valid overrides and
 * the prompt-side arg schemas can all be derived from one declaration
 * instead of three hand-maintained copies that drift (issue #113).
 */
export const DOCUMENT_FORMATS = [
  "pdf",
  "docx",
  "doc",
  "xlsx",
  "rtf",
  "odt",
  "pptx",
  "plain",
] as const;

export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export interface ExtractorInput {
  data: Buffer;
  /** Original file path, purely informational (used in warnings/errors). */
  sourcePath: string;
  /** Page/slide lower bound, 1-indexed. Extractors that ignore pagination may skip this. */
  pagesFrom?: number;
  /** Page/slide upper bound, 1-indexed, inclusive. */
  pagesTo?: number;
  /** Hard cap on pages/slides after pagesFrom/pagesTo clipping. */
  maxPages?: number;
  /** Explicit list of sheets (names or 1-indexed positions) for xlsx. */
  sheets?: readonly (string | number)[];
  /** Insert `--- page N ---` / `--- slide N ---` dividers. Default true. */
  pageSeparators?: boolean;
  /** Render rich structure (headings, tables) as light markdown. Default true. */
  includeTables?: boolean;
}

export interface ExtractResult {
  format: DocumentFormat;
  text: string;
  /** Total pages/slides/sheets in the source, regardless of extraction range. */
  pageCount?: number;
  sheetCount?: number;
  slideCount?: number;
  /** Which 1-indexed pages/slides/sheets actually made it into `text`. */
  pagesExtracted?: number[];
  warnings: string[];
}

export type Extractor = (input: ExtractorInput) => Promise<ExtractResult>;
