import { loadPdfJs } from "./pdf-extractor.js";
import { encodePng } from "./png-encode.js";
import { downscaleToFit, rawImageFromPdfJs, type PdfJsImageData } from "./raw-image.js";

/**
 * The picture of a scanned PDF page, as PNG, without rendering the page
 * (ATO-2205).
 *
 * A scanner or a phone "scan to PDF" app writes each page as one image
 * covering the page, with no text on top. So instead of rasterising the
 * page (which needs a canvas: `@napi-rs/canvas` is an optional pdfjs
 * dependency the bundle does not ship), this walks the page's drawing
 * operators with pdfjs, which is already here, takes the largest image
 * the page paints, and lets pdfjs decode it (JPEG, Flate, CCITT, JBIG2)
 * to raw pixels. Those are shrunk to a size a vision model reads well
 * and written out as PNG.
 *
 * Limits, on purpose: anything drawn over the image (stamps, vector
 * annotations) is not in the picture, and a page made of several image
 * strips gives only the largest strip. A page with no image at all gets a
 * warning instead of a picture.
 */

export interface PdfPageImage {
  /** 1-indexed page number. */
  page: number;
  png?: Buffer;
  width?: number;
  height?: number;
  /** Why there is no picture for this page. */
  warning?: string;
}

export interface PdfPageImageOptions {
  /** Longer side of the PNG, in pixels. Default 2000. */
  maxSide?: number;
  /** Pages whose image has more pixels than this are skipped. Default 80 million. */
  maxPixels?: number;
  /** How long to wait for pdfjs to decode one image. Default 30 s. */
  decodeTimeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_SIDE = 2000;
const DEFAULT_MAX_PIXELS = 80_000_000;
const DEFAULT_DECODE_TIMEOUT_MS = 30_000;

type PdfJs = Awaited<ReturnType<typeof loadPdfJs>>;
type PdfDocument = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;

/** One entry per requested page, in the order asked; never throws for a page. */
export async function extractPdfPageImages(
  data: Buffer,
  pages: readonly number[],
  options: PdfPageImageOptions = {},
): Promise<PdfPageImage[]> {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({
    // A copy: pdfjs takes ownership of (and detaches) the buffer it gets.
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
    // Raw pixels, never an ImageBitmap or a browser ImageDecoder.
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  }).promise;
  const out: PdfPageImage[] = [];
  try {
    for (const page of pages) {
      if (options.signal?.aborted) break;
      if (!Number.isInteger(page) || page < 1 || page > doc.numPages) {
        out.push({ page, warning: "no such page" });
        continue;
      }
      try {
        out.push(await pageImage(doc, pdfjs.OPS.paintImageXObject, page, options));
      } catch (err) {
        out.push({ page, warning: `could not read the page image (${(err as Error).message})` });
      }
    }
  } finally {
    try {
      await doc.destroy();
    } catch {
      // Best-effort cleanup, as in the text extractor.
    }
  }
  return out;
}

async function pageImage(
  doc: PdfDocument,
  paintImageOp: number,
  pageNum: number,
  options: PdfPageImageOptions,
): Promise<PdfPageImage> {
  const page = await doc.getPage(pageNum);
  const ops = await page.getOperatorList();
  let best: { id: string; width: number; height: number } | undefined;
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    if (ops.fnArray[i] !== paintImageOp) continue;
    // `paintImageXObject` arguments: [objId, width, height].
    const [id, width, height] = (ops.argsArray[i] ?? []) as unknown[];
    if (typeof id !== "string" || typeof width !== "number" || typeof height !== "number") continue;
    if (!best || width * height > best.width * best.height) best = { id, width, height };
  }
  if (!best) return { page: pageNum, warning: "no image on the page" };
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  if (best.width * best.height > maxPixels) {
    return { page: pageNum, warning: `page image too large (${best.width}x${best.height})` };
  }
  // pdfjs keeps images shared between pages in `commonObjs` ("g_" ids),
  // the rest per page, the same split its canvas renderer reads.
  const objects = best.id.startsWith("g_") ? page.commonObjs : page.objs;
  const decoded = await decodedImage(objects, best.id, options.decodeTimeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS);
  const raw = decoded ? rawImageFromPdfJs(decoded) : null;
  if (!raw) return { page: pageNum, warning: "the page image could not be decoded" };
  const fitted = downscaleToFit(raw, options.maxSide ?? DEFAULT_MAX_SIDE);
  return { page: pageNum, png: encodePng(fitted), width: fitted.width, height: fitted.height };
}

interface ObjectStore {
  get(id: string, callback: (data: unknown) => void): unknown;
}

/**
 * The decoded image behind an object id. pdfjs sends image data apart
 * from the operator list, so it may land after the list resolves; a
 * failed decode resolves to `null`, and a stuck one times out to `null`.
 */
function decodedImage(objects: ObjectStore, id: string, timeoutMs: number): Promise<PdfJsImageData | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
    objects.get(id, (value) => {
      clearTimeout(timer);
      resolve(isImageData(value) ? value : null);
    });
  });
}

function isImageData(value: unknown): value is PdfJsImageData {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const pixels = v.data instanceof Uint8Array || v.data instanceof Uint8ClampedArray;
  return typeof v.width === "number" && typeof v.height === "number" && pixels;
}
