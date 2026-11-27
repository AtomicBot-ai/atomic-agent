import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TESSERACT_LANGUAGE_BYTES,
  downloadTesseractData,
  formatDataSize,
  tesseractDataDir,
  tesseractDataStatus,
  tesseractDataUrl,
} from "./tesseract-data.js";

// ATO-2502: tesseract language data comes down only with consent, never on a read.
let dir: string;

/** A file of the size the CDN serves for `lang`. */
function fullFile(lang: string): Buffer {
  return Buffer.alloc(TESSERACT_LANGUAGE_BYTES[lang]!);
}

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "atomic-tesseract-data-")), "tesseract");
});

afterEach(() => {
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

describe("tesseract data paths", () => {
  it("keeps the data next to the whisper models, by data version", () => {
    expect(tesseractDataDir("/models")).toBe(join("/models", "tesseract", "4.0.0_best_int"));
    expect(tesseractDataUrl("rus")).toBe("https://cdn.jsdelivr.net/npm/@tesseract.js-data/rus/4.0.0_best_int/rus.traineddata.gz");
  });
});

describe("tesseractDataStatus", () => {
  it("lists what is missing with its size, and languages it has no file for", () => {
    const status = tesseractDataStatus(dir, ["rus", "eng", "xx"]);
    expect(status.missing.map((file) => file.lang)).toEqual(["rus", "eng"]);
    expect(status.missingBytes).toBe(2_679_598 + 2_952_873);
    expect(formatDataSize(status.missingBytes)).toBe("5.6 MB");
    expect(status.unknown).toEqual(["xx"]);
  });

  it("counts a file as there only at its listed size", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rus.traineddata.gz"), fullFile("rus"));
    writeFileSync(join(dir, "eng.traineddata.gz"), "cut off");
    expect(tesseractDataStatus(dir, ["rus", "eng"]).missing.map((file) => file.lang)).toEqual(["eng"]);
    writeFileSync(join(dir, "eng.traineddata.gz"), "");
    expect(tesseractDataStatus(dir, ["eng"]).missing.map((file) => file.lang)).toEqual(["eng"]);
  });
});

describe("downloadTesseractData", () => {
  it("fetches nothing without consent", async () => {
    const download = vi.fn(async () => undefined);
    await expect(downloadTesseractData({ dir, languages: ["rus"], consent: false, download })).rejects.toThrow(/agreed/);
    expect(download).not.toHaveBeenCalled();
  });

  it("fetches only the missing files into the data folder", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "eng.traineddata.gz"), fullFile("eng"));
    const download = vi.fn(async (_url: string, dest: string) => {
      writeFileSync(dest, fullFile("rus"));
    });
    const after = await downloadTesseractData({ dir, languages: ["rus", "eng"], consent: true, download });
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]?.[0]).toBe(tesseractDataUrl("rus"));
    expect(download.mock.calls[0]?.[1]).toBe(join(dir, "rus.traineddata.gz"));
    expect(after.missing).toEqual([]);
  });

  it("refuses a language it has no file for", async () => {
    const download = vi.fn(async () => undefined);
    await expect(downloadTesseractData({ dir, languages: ["xx"], consent: true, download })).rejects.toThrow(/xx/);
    expect(download).not.toHaveBeenCalled();
  });
});
