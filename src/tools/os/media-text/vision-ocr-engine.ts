import { VisionUnsupportedError } from "../../../llm/index.js";
import type { OcrEngine, OcrPageResult } from "../read-document/extractors/ocr-engine.js";
import { extractPdfPageImages, type PdfPageImage } from "../read-document/extractors/pdf-page-images.js";
import type { VisionModel } from "./media-text.js";

/**
 * OCR for scanned PDF pages through the vision model the agent already
 * uses for photos (`media-text.ts`) and `vision.describe` (ATO-2205).
 *
 * Each page without a text layer is pulled out of the PDF as a picture
 * (`pdf-page-images.ts`, pdfjs only, no canvas) and the model is asked to
 * copy its text. No new engine, library or language data: the same
 * precedent as photos in the index (ATO-1051), and as AnythingLLM's
 * collector, which OCRs a PDF whose text layer is empty.
 *
 * It stays on the computer only as far as the vision model does: the
 * caller decides which provider to hand in (the file index wiring passes
 * a local one only). Language codes are ignored; the prompt keeps the
 * page's own language.
 */

/** What the vision model is asked for each scanned page. */
export const SCAN_PAGE_TEXT_PROMPT =
  "This image is one scanned page of a document. Copy out all text on it exactly as written, " +
  "keeping line breaks, table rows and the original language. Do not translate, summarise or comment. " +
  "If the page has no text, answer with an empty reply.";

export const VISION_OCR_ENGINE_ID = "vision-model";

export interface VisionOcrEngineOptions {
  /** The provider `vision.describe` would use, read on every call. */
  vision?: VisionModel | (() => VisionModel | undefined);
  /** Per-image cap mirrored from `config.vision.maxImageBytes`. Default 20 MB. */
  maxImageBytes?: number;
  /** Longer side of the page picture, in pixels. Default 2000. */
  maxSide?: number;
  /** Test seam: page pictures instead of reading them out of the PDF. */
  pageImages?: (data: Buffer, pages: readonly number[], signal?: AbortSignal) => Promise<PdfPageImage[]>;
}

const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function createVisionOcrEngine(options: VisionOcrEngineOptions): OcrEngine {
  const current = (): VisionModel | undefined =>
    typeof options.vision === "function" ? options.vision() : options.vision;
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const pageImages =
    options.pageImages ??
    ((data: Buffer, pages: readonly number[], signal?: AbortSignal) =>
      extractPdfPageImages(data, pages, {
        ...(options.maxSide !== undefined ? { maxSide: options.maxSide } : {}),
        ...(signal ? { signal } : {}),
      }));

  return {
    id: VISION_OCR_ENGINE_ID,
    async unavailableReason() {
      return visionUnavailable(current());
    },
    async recognizePdfPages(request) {
      const vision = current();
      const unavailable = visionUnavailable(vision);
      if (unavailable !== undefined || vision === undefined) throw new Error(unavailable ?? "no vision model");
      const images = await pageImages(request.data, request.pages, request.signal);
      const pages: OcrPageResult[] = [];
      const warnings: string[] = [];
      for (const image of images) {
        if (request.signal?.aborted) break;
        if (!image.png) {
          warnings.push(`page ${image.page}: ${image.warning ?? "no page image"}, not recognised`);
          continue;
        }
        if (image.png.length > maxImageBytes) {
          warnings.push(`page ${image.page}: page image is ${image.png.length} bytes, over ${maxImageBytes}, not recognised`);
          continue;
        }
        try {
          const result = await vision.describeImage({
            prompt: SCAN_PAGE_TEXT_PROMPT,
            images: [{ id: 1, bytes: image.png, mimeType: "image/png" }],
            ...(request.signal ? { signal: request.signal } : {}),
          });
          pages.push({ page: image.page, text: result.text.trim() });
        } catch (err) {
          // The model cannot take images at all: every page would fail
          // the same way, so the whole run stops and the caller reports it.
          if (err instanceof VisionUnsupportedError) throw err;
          warnings.push(`page ${image.page}: vision model failed (${(err as Error).message})`);
        }
      }
      return { pages, warnings };
    },
  };
}

function visionUnavailable(vision: VisionModel | undefined): string | undefined {
  if (vision === undefined) return "no vision model is configured";
  if (!vision.capabilities.vision) return `${vision.name} cannot read images`;
  return undefined;
}
