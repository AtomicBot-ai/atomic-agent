import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import {
  detectDocumentFormat,
  resolveDocumentExtractor,
  type DocumentFormat,
  type Extractor,
} from "../os/read-document/index.js";
import { extractMediaText, mediaKindForPath, type MediaTextOptions } from "../os/media-text/media-text.js";
import { pageSegments, type TextSegment } from "./file-chunker.js";

/**
 * The text of one file for the index, through the readers the agent
 * already has: `os.fs.read_document`'s extractors for documents (PDF
 * pages kept), and `media-text.ts` for photos and audio, only when the
 * caller turned it on. A file nothing can read is `skipped` with the
 * reason; a reader that throws is `failed`.
 */
export type FileTextResult =
  | { status: "ok"; segments: TextSegment[] }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

export interface FileTextOptions {
  /** Photos and audio: `media-text.ts` options. Off (`enabled` unset) skips them. */
  media?: MediaTextOptions;
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
  const extractor = await resolveDocumentExtractor(format, options.extractors ? { extractors: options.extractors } : {});
  const result = await extractor({
    data: await readFile(path),
    sourcePath: path,
    maxPages: options.maxPages ?? DEFAULT_MAX_PAGES,
    pageSeparators: true,
    includeTables: true,
  });
  if (format === "pdf" && result.textLayer?.status === "scanned") {
    return { status: "skipped", reason: "scanned PDF without a text layer (OCR is not wired into the index yet)" };
  }
  // Only PDF pages become citations (`#page=N`); other formats keep
  // their slide/chapter dividers as plain text.
  const segments = format === "pdf" ? pageSegments(result.text) : nonEmpty(result.text);
  if (segments.length === 0) return { status: "skipped", reason: "no text in the file" };
  return { status: "ok", segments };
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

function nonEmpty(text: string): TextSegment[] {
  return text.trim().length > 0 ? [{ text }] : [];
}
