/**
 * Pluggable OCR seam for the PDF extractor (ATO-681).
 *
 * No engine ships yet: which one to use (pure-JS tesseract.js vs an
 * on-demand native parser) is decided by a measurement on real Russian
 * scans, not here. This interface is what either candidate implements so it
 * can be dropped in without touching the extractor again.
 *
 * Contract for implementations:
 * - Run fully locally. Language data (at least `rus` and `eng`) must already
 *   be on disk; an engine must never download models or traineddata from a
 *   CDN as a side effect of a read. If the data is missing, report it via
 *   `unavailableReason` instead of fetching it.
 * - Only touch the pages it is asked for: pages that already have a text
 *   layer are never re-recognised.
 * - Never throw for a single bad page; return it with empty text and a
 *   warning so the rest of the document still comes through.
 */

import type { ExtractorInput } from "./extractor-types.js";
import {
  assessTextLayer,
  hasTextLayer,
  type PageText,
  type TextLayerAssessment,
} from "./scan-detection.js";

export interface OcrPageRequest {
  /** The original PDF bytes. */
  data: Buffer;
  /** Informational, for warnings. */
  sourcePath: string;
  /** 1-indexed pages that have no text layer and need recognising. */
  pages: readonly number[];
  /** Tesseract-style language codes, e.g. `["rus", "eng"]`. */
  languages: readonly string[];
  signal?: AbortSignal;
}

export interface OcrPageResult {
  page: number;
  text: string;
  /** 0..1 when the engine reports it. */
  confidence?: number;
}

export interface OcrRunResult {
  pages: OcrPageResult[];
  warnings: string[];
}

export interface OcrEngine {
  /** Short stable id for details/telemetry, e.g. "tesseract-js". */
  readonly id: string;
  /**
   * Cheap local check (no network). `undefined` means ready; a string is a
   * human-readable reason the engine cannot run right now (missing language
   * data, binary not installed yet), surfaced to the model as-is.
   */
  unavailableReason(languages: readonly string[]): Promise<string | undefined>;
  recognizePdfPages(request: OcrPageRequest): Promise<OcrRunResult>;
}

/** Languages asked for when the caller does not say otherwise. */
export const DEFAULT_OCR_LANGUAGES: readonly string[] = ["rus", "eng"];

/**
 * Assess the text layer of the extracted pages and, when an engine is
 * plugged in and some pages have no text, recognise just those pages and
 * splice the result in place. With no engine (today's default) this is the
 * assessment alone. Engine failures never fail the read: they become a
 * warning and the pages stay reported as missing text.
 */
export async function assessAndOcr(
  pages: PageText[],
  input: ExtractorInput,
  warnings: string[],
  engine?: OcrEngine,
  languages: readonly string[] = DEFAULT_OCR_LANGUAGES,
): Promise<{ assessment: TextLayerAssessment; ocrEngineId?: string }> {
  const assessment = assessTextLayer(pages);
  if (!engine || !assessment.ocrNeeded) return { assessment };
  try {
    const reason = await engine.unavailableReason(languages);
    if (reason !== undefined) {
      warnings.push(`OCR engine ${engine.id} unavailable: ${reason}`);
      return { assessment };
    }
    const run = await engine.recognizePdfPages({
      data: input.data,
      sourcePath: input.sourcePath,
      pages: assessment.pagesWithoutText,
      languages,
    });
    warnings.push(...run.warnings);
    mergeOcrText(pages, run.pages);
  } catch (err) {
    warnings.push(`OCR engine ${engine.id} failed: ${(err as Error).message}`);
    return { assessment };
  }
  return { assessment: assessTextLayer(pages), ocrEngineId: engine.id };
}

/**
 * Replace the text of pages that had no text layer with the engine's
 * output. A page that already had text is never overwritten, whatever the
 * engine returned for it.
 */
export function mergeOcrText(
  pages: PageText[],
  recognised: readonly OcrPageResult[],
): void {
  const byPage = new Map(recognised.map((r) => [r.page, r.text]));
  for (const entry of pages) {
    if (hasTextLayer(entry.text)) continue;
    const text = byPage.get(entry.page);
    if (text !== undefined) entry.text = text.trim();
  }
}
