import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PdfPageImage } from "../read-document/extractors/pdf-page-images.js";
import { TESSERACT_LANGUAGE_BYTES } from "./tesseract-data.js";
import {
  createTesseractOcrEngine,
  loadTesseract,
  TESSERACT_OCR_ENGINE_ID,
  type TesseractModule,
  type TesseractWorker,
} from "./tesseract-ocr-engine.js";

// ATO-2502: the offline OCR engine, with a fake tesseract.js.
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const REQUEST = { data: Buffer.from("%PDF"), sourcePath: "/x/scan.pdf", pages: [1, 2], languages: ["rus", "eng"] };
const pictures = (pages: readonly number[]): PdfPageImage[] => pages.map((page) => ({ page, png: PNG }));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-tesseract-engine-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function withData(...langs: string[]): void {
  mkdirSync(dir, { recursive: true });
  for (const lang of langs) writeFileSync(join(dir, `${lang}.traineddata.gz`), Buffer.alloc(TESSERACT_LANGUAGE_BYTES[lang]!));
}

function fakeTesseract(over: { fail?: (call: number) => Error | undefined; startError?: Error } = {}) {
  let call = 0;
  const recognize = vi.fn(async (_image: Buffer) => {
    call += 1;
    const error = over.fail?.(call);
    if (error) throw error;
    return { data: { text: `  Договор аренды, страница ${call}\n`, confidence: 87 } };
  });
  const terminate = vi.fn(async () => undefined);
  const worker: TesseractWorker = { recognize, terminate };
  const createWorker = vi.fn(async (_languages: string, _oem: number, _options: Record<string, unknown>) => {
    if (over.startError) throw over.startError;
    return worker;
  });
  const mod: TesseractModule = { createWorker };
  return { load: async () => mod, createWorker, recognize, terminate };
}

describe("createTesseractOcrEngine (ATO-2502)", () => {
  it("says it is not installed when the package is missing", async () => {
    withData("rus", "eng");
    const engine = createTesseractOcrEngine({ dataDir: dir, load: async () => undefined });
    expect(engine.id).toBe(TESSERACT_OCR_ENGINE_ID);
    expect(await engine.unavailableReason(["rus", "eng"])).toBe("tesseract.js is not installed");
    await expect(engine.recognizePdfPages(REQUEST)).rejects.toThrow("tesseract.js is not installed");
  });

  it("names the missing language data and its size instead of fetching it", async () => {
    withData("eng");
    const fake = fakeTesseract();
    const engine = createTesseractOcrEngine({ dataDir: dir, load: fake.load, pageImages: async (_d, pages) => pictures(pages) });
    expect(await engine.unavailableReason(["rus", "eng"])).toBe("tesseract language data rus (2.7 MB) is not downloaded yet");
    expect(await engine.unavailableReason(["xx"])).toBe("no tesseract language data for xx");
    await expect(engine.recognizePdfPages(REQUEST)).rejects.toThrow(/not downloaded yet/);
    expect(fake.createWorker).not.toHaveBeenCalled();
  });

  it("reads each page from the local data folder only, with one worker, and terminates it", async () => {
    withData("rus", "eng");
    const fake = fakeTesseract();
    const engine = createTesseractOcrEngine({ dataDir: () => dir, load: fake.load, pageImages: async (_d, pages) => pictures(pages) });
    expect(await engine.unavailableReason(["rus", "eng"])).toBeUndefined();
    const run = await engine.recognizePdfPages(REQUEST);
    expect(run).toEqual({
      pages: [
        { page: 1, text: "Договор аренды, страница 1", confidence: 0.87 },
        { page: 2, text: "Договор аренды, страница 2", confidence: 0.87 },
      ],
      warnings: [],
    });
    expect(fake.createWorker).toHaveBeenCalledTimes(1);
    expect(fake.createWorker).toHaveBeenCalledWith("rus+eng", 1, { langPath: dir, cachePath: dir, cacheMethod: "none", gzip: true });
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it("keeps going past a page that fails or has no picture", async () => {
    withData("rus", "eng");
    const fake = fakeTesseract({ fail: (call) => (call === 1 ? new Error("bad image") : undefined) });
    const engine = createTesseractOcrEngine({
      dataDir: dir,
      load: fake.load,
      pageImages: async () => [{ page: 1, png: PNG }, { page: 2, warning: "no image on the page" }, { page: 3, png: PNG }],
    });
    const run = await engine.recognizePdfPages({ ...REQUEST, pages: [1, 2, 3] });
    expect(run.pages.map((p) => p.page)).toEqual([3]);
    expect(run.warnings).toEqual([
      "page 1: tesseract failed (bad image)",
      "page 2: no image on the page, not recognised",
    ]);
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it("throws when the worker cannot start, so the caller reports the file", async () => {
    withData("rus", "eng");
    const fake = fakeTesseract({ startError: new Error("wasm failed") });
    const engine = createTesseractOcrEngine({ dataDir: dir, load: fake.load, pageImages: async (_d, pages) => pictures(pages) });
    await expect(engine.recognizePdfPages(REQUEST)).rejects.toThrow("wasm failed");
  });

  it("starts no worker for a file with no page pictures", async () => {
    withData("rus", "eng");
    const fake = fakeTesseract();
    const engine = createTesseractOcrEngine({ dataDir: dir, load: fake.load, pageImages: async () => [{ page: 1, warning: "no such page" }] });
    await engine.recognizePdfPages({ ...REQUEST, pages: [1] });
    expect(fake.createWorker).not.toHaveBeenCalled();
  });
});

describe("loadTesseract", () => {
  it("answers undefined, not a throw, when the package is not installed", async () => {
    // tesseract.js is not a dependency; a checkout with it installed for
    // the benchmark answers the module instead.
    const mod = await loadTesseract();
    expect(mod === undefined || typeof mod.createWorker === "function").toBe(true);
  });
});
