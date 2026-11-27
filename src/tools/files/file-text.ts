import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import {
  detectDocumentFormat,
  resolveDocumentExtractor,
  type DocumentFormat,
  type Extractor,
} from "../os/read-document/index.js";
import { extractMediaText, mediaKindForPath, type MediaTextOptions } from "../os/media-text/media-text.js";
import { boundOcrEngine, DEFAULT_OCR_LANGUAGES, type OcrEngine } from "../os/read-document/extractors/ocr-engine.js";
import { createPdfExtractor } from "../os/read-document/extractors/pdf-extractor.js";
import { pageSegments, type TextSegment } from "./file-chunker.js";

/**
 * The text of one file for the index, through the readers the agent
 * already has: `os.fs.read_document`'s extractors for documents (PDF
 * pages kept), and `media-text.ts` for photos and audio, only when the
 * caller turned it on. Pages of a PDF without a text layer go to the OCR
 * engine when one is passed (ATO-2205), up to `ocr.maxPages` per file. A
 * file nothing can read is `skipped` with the reason (a scan says why OCR
 * did not read it: `scan: OCR not available (...)`); a reader that throws
 * is `failed`.
 */
export type FileTextResult =
  /** `ocrPages`: scanned pages the OCR engine read text from (ATO-2501), when any. */
  | { status: "ok"; segments: TextSegment[]; ocrPages?: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

export interface FileOcrOptions {
  /** The engine for scanned pages, read per file; unset means scans are skipped. */
  engine?: OcrEngine | (() => OcrEngine | undefined);
  /** Most scanned pages recognised per file. Default 30. */
  maxPages?: number;
  /** Default `["rus", "eng"]`. */
  languages?: readonly string[];
}

export interface FileTextOptions {
  /** Photos and audio: `media-text.ts` options. Off (`enabled` unset) skips them. */
  media?: MediaTextOptions;
  /** Scanned PDF pages. Without an engine a scan is skipped with the reason. */
  ocr?: FileOcrOptions;
  /** Most PDF pages read per file. Default 2000. */
  maxPages?: number;
  /** Test seam: extractors by format, instead of the real libraries. */
  extractors?: Partial<Record<DocumentFormat, Extractor>>;
  signal?: AbortSignal;
}

/**
 * Document extensions the index reads. Narrower than `read_document`:
 * no extensionless files and no data/config formats (`json`, `xml`,
 * `yaml`, `log`), which flood a search with noise.
 */
export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".pdf", ".docx", ".doc", ".xlsx", ".rtf", ".odt", ".pptx", ".ods", ".odp", ".epub",
  ".html", ".htm", ".eml", ".txt", ".md", ".csv", ".tsv",
]);

/** Whether the index counts this file at all (documents, photos, audio). */
export function isIndexablePath(path: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extname(path).toLowerCase()) || mediaKindForPath(path) !== null;
}

const DEFAULT_MAX_PAGES = 2000;
/** A scanned page costs one vision call; 30 covers most contracts and receipts. */
export const DEFAULT_MAX_OCR_PAGES = 30;

export async function extractFileText(path: string, options: FileTextOptions = {}): Promise<FileTextResult> {
  try {
    if (mediaKindForPath(path) !== null) return await mediaText(path, options);
    if (!DOCUMENT_EXTENSIONS.has(extname(path).toLowerCase())) {
      return { status: "skipped", reason: "unsupported file type" };
    }
    return await documentText(path, options);
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

async function documentText(path: string, options: FileTextOptions): Promise<FileTextResult> {
  const format = detectDocumentFormat(path, undefined);
  const ocr: ReadyOcr = format === "pdf" ? await readyOcr(options) : { engine: undefined, unavailable: undefined, recognised: NO_OCR_PAGES };
  const extractors = ocr.engine && !options.extractors?.pdf
    ? { ...options.extractors, pdf: createPdfExtractor({ ocrEngine: ocr.engine, ocrLanguages: ocrLanguages(options) }) }
    : options.extractors;
  const extractor = await resolveDocumentExtractor(format, extractors ? { extractors } : {});
  const result = await extractor({
    data: await readFile(path),
    sourcePath: path,
    maxPages: options.maxPages ?? DEFAULT_MAX_PAGES,
    pageSeparators: true,
    includeTables: true,
  });
  if (format === "pdf" && result.textLayer?.status === "scanned") {
    return { status: "skipped", reason: scanSkipReason(result.warnings, ocr) };
  }
  // Only PDF pages become citations (`#page=N`); other formats keep
  // their slide/chapter dividers as plain text.
  const segments = format === "pdf" ? pageSegments(result.text) : nonEmpty(result.text);
  if (segments.length === 0) return { status: "skipped", reason: "no text in the file" };
  const ocrPages = ocr.recognised();
  return ocrPages > 0 ? { status: "ok", segments, ocrPages } : { status: "ok", segments };
}

async function mediaText(path: string, options: FileTextOptions): Promise<FileTextResult> {
  const result = await extractMediaText(path, {
    ...options.media,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (result.status === "skipped") {
    return { status: "skipped", reason: result.detail ? `${result.reason}: ${result.detail}` : result.reason };
  }
  if (result.status === "failed") return { status: "failed", error: result.error };
  // whisper.cpp runs with `-nt` (no timestamps), so a transcript is one
  // segment without a time; the store and the citation take one when a
  // timestamped transcript arrives.
  const segments = nonEmpty(result.text);
  return segments.length === 0 ? { status: "skipped", reason: "no text in the file" } : { status: "ok", segments };
}

interface ReadyOcr {
  /** Bounded, ready to run; unset when there is none or it cannot run. */
  engine: OcrEngine | undefined;
  /** Why scans cannot be read right now. */
  unavailable: string | undefined;
  /** Pages the engine returned text for so far. */
  recognised: () => number;
}

const NO_OCR_PAGES = (): number => 0;

/**
 * The engine, checked once per PDF (a cheap local check), so a scan that
 * stays unread says why: no engine set up, or the engine's own reason.
 */
async function readyOcr(options: FileTextOptions): Promise<ReadyOcr> {
  const raw = typeof options.ocr?.engine === "function" ? options.ocr.engine() : options.ocr?.engine;
  if (raw === undefined) return { engine: undefined, unavailable: "no OCR engine is set up for the file index", recognised: NO_OCR_PAGES };
  let unavailable: string | undefined;
  try {
    unavailable = await raw.unavailableReason(ocrLanguages(options));
  } catch (error) {
    unavailable = error instanceof Error ? error.message : String(error);
  }
  if (unavailable !== undefined) return { engine: undefined, unavailable, recognised: NO_OCR_PAGES };
  const bounded = boundOcrEngine(raw, {
    maxPages: options.ocr?.maxPages ?? DEFAULT_MAX_OCR_PAGES,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  let recognised = 0;
  const engine: OcrEngine = {
    id: bounded.id,
    unavailableReason: (languages) => bounded.unavailableReason(languages),
    async recognizePdfPages(request) {
      const run = await bounded.recognizePdfPages(request);
      recognised += run.pages.filter((page) => page.text.trim().length > 0).length;
      return run;
    },
  };
  return { engine, unavailable: undefined, recognised: () => recognised };
}

function ocrLanguages(options: FileTextOptions): readonly string[] {
  return options.ocr?.languages ?? DEFAULT_OCR_LANGUAGES;
}

/** The skip reason of a PDF that is still a scan after the OCR step. */
function scanSkipReason(warnings: readonly string[], ocr: ReadyOcr): string {
  const engine = ocr.engine;
  if (engine === undefined) return `scan: OCR not available (${ocr.unavailable ?? "no OCR engine"})`;
  const failedPrefix = `OCR engine ${engine.id} failed: `;
  const failed = warnings.find((w) => w.startsWith(failedPrefix));
  if (failed !== undefined) return `scan: OCR failed (${failed.slice(failedPrefix.length)})`;
  const unavailablePrefix = `OCR engine ${engine.id} unavailable: `;
  const unavailable = warnings.find((w) => w.startsWith(unavailablePrefix));
  if (unavailable !== undefined) return `scan: OCR not available (${unavailable.slice(unavailablePrefix.length)})`;
  return "scan: OCR found no text";
}

/**
 * Skip reasons that a later run can turn into text once the reader is
 * there (ATO-2501): a scan whose OCR engine was missing or failed, a photo
 * or audio file skipped because media reading was off or its model,
 * whisper.cpp or ffmpeg was missing. Not retried: wrong type, too large,
 * no text, OCR that ran and found none.
 */
export function isRetryableSkip(reason: string): boolean {
  if (reason.startsWith("scan: OCR not available") || reason.startsWith("scan: OCR failed")) return true;
  const media = reason.split(":", 1)[0] ?? "";
  return RETRYABLE_MEDIA_SKIPS.has(media);
}

const RETRYABLE_MEDIA_SKIPS: ReadonlySet<string> = new Set([
  "disabled", "no-vision-model", "no-engine", "needs-model-download", "no-model", "needs-ffmpeg",
]);

function nonEmpty(text: string): TextSegment[] {
  return text.trim().length > 0 ? [{ text }] : [];
}
