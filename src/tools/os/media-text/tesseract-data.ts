import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { downloadFile } from "../../../local-llm/downloads/download-file.js";

/**
 * Language data for the tesseract.js OCR engine (ATO-2502).
 *
 * tesseract.js reads `<lang>.traineddata.gz` from a local folder when its
 * `langPath` is a path, not a URL, and fetches nothing then. Without one
 * it pulls the same files from jsDelivr on first use, which the OCR seam
 * forbids (`ocr-engine.ts`: an engine never downloads as a side effect
 * of a read). So the files live in
 * `<localModelsDataDir>/tesseract/4.0.0_best_int/`, next to the whisper
 * models, and come down only through {@link downloadTesseractData} with
 * `consent: true`: the same rule as a whisper model in `media-text.ts`,
 * where the caller is told the size first.
 *
 * `4.0.0_best_int` is the set tesseract.js itself uses for the LSTM
 * engine (OEM 1): the "best" models quantised to integers, smaller and
 * faster than "best" at nearly the same accuracy.
 */

export const TESSERACT_DATA_VERSION = "4.0.0_best_int";

/**
 * Bytes of each `<lang>.traineddata.gz` this module knows, read from the
 * CDN's `Content-Length` on 28.11.2026. A file on disk counts only at
 * exactly this size. A language not listed here is not offered for
 * download.
 */
export const TESSERACT_LANGUAGE_BYTES: Readonly<Record<string, number>> = {
  eng: 2_952_873,
  rus: 2_679_598,
};

export interface TesseractDataFile {
  lang: string;
  bytes: number;
  url: string;
  path: string;
}

export interface TesseractDataStatus {
  dir: string;
  /**
   * Known languages whose file is not on disk yet, or is not the size
   * listed in {@link TESSERACT_LANGUAGE_BYTES} (a cut-off or foreign file).
   */
  missing: TesseractDataFile[];
  /** Asked-for languages this module has no file for. */
  unknown: string[];
  /** Sum of `missing[].bytes`. */
  missingBytes: number;
}

export function tesseractDataDir(localModelsDataDir: string): string {
  return join(localModelsDataDir, "tesseract", TESSERACT_DATA_VERSION);
}

export function tesseractDataUrl(lang: string): string {
  return `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/${TESSERACT_DATA_VERSION}/${lang}.traineddata.gz`;
}

export function tesseractDataFileName(lang: string): string {
  return `${lang}.traineddata.gz`;
}

/** Which of `languages` are on disk in `dir`. Reads only file sizes. */
export function tesseractDataStatus(dir: string, languages: readonly string[]): TesseractDataStatus {
  const missing: TesseractDataFile[] = [];
  const unknown: string[] = [];
  for (const lang of new Set(languages)) {
    const bytes = TESSERACT_LANGUAGE_BYTES[lang];
    if (bytes === undefined) {
      unknown.push(lang);
      continue;
    }
    const path = join(dir, tesseractDataFileName(lang));
    if (fileSize(path) === bytes) continue;
    missing.push({ lang, bytes, url: tesseractDataUrl(lang), path });
  }
  return { dir, missing, unknown, missingBytes: missing.reduce((sum, file) => sum + file.bytes, 0) };
}

/** "5.6 MB", for the consent text and the skip reason. */
export function formatDataSize(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export interface DownloadTesseractDataOptions {
  dir: string;
  languages: readonly string[];
  /**
   * Must be `true`: the person was shown {@link TesseractDataStatus.missingBytes}
   * and agreed. Anything else throws before a byte is fetched.
   */
  consent: boolean;
  signal?: AbortSignal;
  /** Test seam; default `downloadFile` (resumable, retried). */
  download?: (url: string, dest: string, signal?: AbortSignal) => Promise<void>;
}

/** Fetches the missing files; answers the status after the download. */
export async function downloadTesseractData(options: DownloadTesseractDataOptions): Promise<TesseractDataStatus> {
  if (options.consent !== true) {
    throw new Error("tesseract language data is downloaded only after the person agreed to its size");
  }
  const before = tesseractDataStatus(options.dir, options.languages);
  if (before.unknown.length > 0) {
    throw new Error(`no tesseract language data for ${before.unknown.join(", ")}`);
  }
  if (before.missing.length === 0) return before;
  await mkdir(options.dir, { recursive: true });
  const download = options.download ?? defaultDownload;
  for (const file of before.missing) {
    await download(file.url, file.path, options.signal);
  }
  return tesseractDataStatus(options.dir, options.languages);
}

const defaultDownload = (url: string, dest: string, signal?: AbortSignal) =>
  downloadFile(url, dest, signal ? { signal } : {});

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
