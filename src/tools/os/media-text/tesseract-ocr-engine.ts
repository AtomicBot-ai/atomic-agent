import type { OcrEngine, OcrPageResult } from "../read-document/extractors/ocr-engine.js";
import { extractPdfPageImages, type PdfPageImage } from "../read-document/extractors/pdf-page-images.js";
import { formatDataSize, tesseractDataStatus } from "./tesseract-data.js";

/**
 * OCR for scanned PDF pages with tesseract.js (ATO-2502): a WebAssembly
 * build of Tesseract that runs in a worker thread, with no model server
 * and no network. The offline engine for when no vision model is served
 * on this computer; the precedent is Paperless-ngx, which OCRs every scan
 * with Tesseract locally.
 *
 * - The package is optional, like `sqlite-vec` (`file-vec-extension.ts`):
 *   loaded through a variable specifier, so neither `tsc` nor the import
 *   checker requires it and the SEA bundle does not pull it in. Without
 *   it the engine answers "tesseract.js is not installed". Whether it
 *   ships is decided by the Russian-scan measurement
 *   (`docs/plans/ocr-russian-scans-benchmark.md`).
 * - Language data is read only from the data folder
 *   (`tesseract-data.ts`), `cacheMethod: "none"`: nothing is fetched or
 *   written while a file is read. Missing data is an unavailable reason
 *   with its size, and the file is skipped until it is downloaded.
 * - Pages come out of the PDF the same way as for the vision engine
 *   (`pdf-page-images.ts`, the largest image on the page, as PNG). One
 *   worker serves all pages of a file and is terminated after.
 */

export const TESSERACT_OCR_ENGINE_ID = "tesseract-js";

/** The package the engine loads; a variable so nothing requires it at build time. */
const TESSERACT_PACKAGE = "tesseract.js";

/** LSTM only, the engine `4.0.0_best_int` data is made for. */
const OEM_LSTM_ONLY = 1;

/** The part of a tesseract.js worker this engine calls. */
export interface TesseractWorker {
  recognize(image: Buffer): Promise<{ data: { text: string; confidence?: number } }>;
  terminate(): Promise<unknown>;
}

export interface TesseractModule {
  createWorker(languages: string, oem: number, options: Record<string, unknown>): Promise<TesseractWorker>;
}

/** `undefined` when the package is not installed. */
export type TesseractLoader = () => Promise<TesseractModule | undefined>;

interface TesseractImport {
  createWorker?: TesseractModule["createWorker"];
  default?: { createWorker?: TesseractModule["createWorker"] };
}

export const loadTesseract: TesseractLoader = async () => {
  try {
    const mod = (await import(TESSERACT_PACKAGE)) as TesseractImport;
    const createWorker = mod.createWorker ?? mod.default?.createWorker;
    return typeof createWorker === "function" ? { createWorker } : undefined;
  } catch {
    return undefined;
  }
};

export interface TesseractOcrEngineOptions {
  /** The folder with `<lang>.traineddata.gz`, read on every call (`tesseractDataDir`). */
  dataDir: string | (() => string);
  /** Longer side of the page picture, in pixels. Default 2000, as for the vision engine. */
  maxSide?: number;
  /** Test seam: the package. Default {@link loadTesseract}. */
  load?: TesseractLoader;
  /** Test seam: page pictures instead of reading them out of the PDF. */
  pageImages?: (data: Buffer, pages: readonly number[], signal?: AbortSignal) => Promise<PdfPageImage[]>;
}

export function createTesseractOcrEngine(options: TesseractOcrEngineOptions): OcrEngine {
  const dataDir = (): string => (typeof options.dataDir === "function" ? options.dataDir() : options.dataDir);
  const load = options.load ?? loadTesseract;
  const pageImages =
    options.pageImages ??
    ((data: Buffer, pages: readonly number[], signal?: AbortSignal) =>
      extractPdfPageImages(data, pages, {
        ...(options.maxSide !== undefined ? { maxSide: options.maxSide } : {}),
        ...(signal ? { signal } : {}),
      }));

  const unavailable = async (languages: readonly string[]): Promise<string | undefined> => {
    if ((await load()) === undefined) return "tesseract.js is not installed";
    return dataUnavailable(dataDir(), languages);
  };

  return {
    id: TESSERACT_OCR_ENGINE_ID,
    unavailableReason: unavailable,
    async recognizePdfPages(request) {
      const tesseract = await load();
      if (tesseract === undefined) throw new Error("tesseract.js is not installed");
      const dir = dataDir();
      const missing = dataUnavailable(dir, request.languages);
      if (missing !== undefined) throw new Error(missing);
      const images = await pageImages(request.data, request.pages, request.signal);
      const pages: OcrPageResult[] = [];
      const warnings: string[] = [];
      let worker: TesseractWorker | undefined;
      try {
        for (const image of images) {
          if (request.signal?.aborted) break;
          if (!image.png) {
            warnings.push(`page ${image.page}: ${image.warning ?? "no page image"}, not recognised`);
            continue;
          }
          // A worker that cannot start (broken wasm, unreadable data)
          // would fail every page: it throws, and the caller reports it.
          worker ??= await tesseract.createWorker(request.languages.join("+"), OEM_LSTM_ONLY, {
            langPath: dir,
            cachePath: dir,
            cacheMethod: "none",
            gzip: true,
          });
          try {
            const { data } = await worker.recognize(image.png);
            pages.push({ page: image.page, text: data.text.trim(), ...confidence(data.confidence) });
          } catch (err) {
            warnings.push(`page ${image.page}: tesseract failed (${(err as Error).message})`);
          }
        }
      } finally {
        await worker?.terminate().catch(() => undefined);
      }
      return { pages, warnings };
    },
  };
}

function dataUnavailable(dir: string, languages: readonly string[]): string | undefined {
  const status = tesseractDataStatus(dir, languages);
  if (status.unknown.length > 0) return `no tesseract language data for ${status.unknown.join(", ")}`;
  if (status.missing.length === 0) return undefined;
  const names = status.missing.map((file) => file.lang).join("+");
  return `tesseract language data ${names} (${formatDataSize(status.missingBytes)}) is not downloaded yet`;
}

/** tesseract.js reports 0..100; the seam wants 0..1. */
function confidence(value: number | undefined): { confidence?: number } {
  if (typeof value !== "number" || !Number.isFinite(value)) return {};
  return { confidence: Math.min(1, Math.max(0, value / 100)) };
}
