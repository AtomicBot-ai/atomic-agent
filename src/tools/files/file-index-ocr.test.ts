import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OcrEngine } from "../os/read-document/index.js";
import type { MediaTextOptions } from "../os/media-text/media-text.js";
import { buildTestPdf } from "../os/read-document/extractors/scan-pdf-test-helpers.js";
import { FileIndex, type FileIndexOptions } from "./file-index.js";
import { isRetryableSkip } from "./file-text.js";

// ATO-2501: the switch that turns scans on later, and what "My files" shows about them.
let root: string;
let scans: string;
let index: FileIndex | null = null;

const page = { image: { width: 200, height: 260 } };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-file-index-ocr-")));
  scans = join(root, "scans");
  mkdirSync(scans);
  mkdirSync(join(root, "home"));
  writeFileSync(join(scans, "lease-scan.pdf"), buildTestPdf([page, page, page]));
});

afterEach(async () => {
  await index?.close();
  index = null;
  rmSync(root, { recursive: true, force: true });
});

function open(extra: Partial<FileIndexOptions>): FileIndex {
  index = new FileIndex({
    dbFile: join(root, "state", "files-index.sqlite"),
    validation: { systemDirs: [], home: join(root, "home") },
    vectorExtension: false,
    ...extra,
  });
  return index;
}

/** Reads text on pages 1 and 3; page 2 comes back blank. */
const engine: OcrEngine = {
  id: "fake-ocr",
  unavailableReason: async () => undefined,
  recognizePdfPages: async (request) => ({
    pages: request.pages.map((n) => ({ page: n, text: n === 2 ? "" : `Договор аренды, страница ${n}.` })),
    warnings: [],
  }),
};

describe("FileIndex: OCR switch and status (ATO-2501)", () => {
  it("counts the scanned pages OCR read", async () => {
    const fileIndex = open({ ocr: { engine } });
    await fileIndex.addFolder(scans);
    await fileIndex.idle();
    expect(fileIndex.status()).toMatchObject({ indexed: 1, skipped: 0, ocrPages: 2, skippedReasons: [] });
  });

  it("lists why a scan was skipped, and reads it on retry once an engine is there", async () => {
    let current: OcrEngine | undefined;
    const fileIndex = open({ ocr: { engine: () => current } });
    await fileIndex.addFolder(scans);
    await fileIndex.idle();
    const skipped = fileIndex.status();
    expect(skipped).toMatchObject({ indexed: 0, skipped: 1, ocrPages: 0 });
    expect(skipped.skippedReasons).toEqual([
      { reason: "scan: OCR not available (no OCR engine is set up for the file index)", count: 1 },
    ]);

    // Without a retry a skipped file is read again only once it changes.
    current = engine;
    fileIndex.start();
    await fileIndex.idle();
    expect(fileIndex.status()).toMatchObject({ indexed: 0, skipped: 1 });

    expect(fileIndex.retrySkipped()).toBe(1);
    await fileIndex.idle();
    expect(fileIndex.status()).toMatchObject({ indexed: 1, skipped: 0, ocrPages: 2, skippedReasons: [] });
    const hits = await fileIndex.search({ query: "аренды" });
    expect(hits.map((hit) => hit.page).sort()).toEqual([1, 3]);
  });

  it("does not retry files no reader can change", async () => {
    writeFileSync(join(scans, "empty.txt"), "   ");
    const fileIndex = open({ ocr: { engine } });
    await fileIndex.addFolder(scans);
    await fileIndex.idle();
    expect(fileIndex.status()).toMatchObject({ skipped: 1, skippedReasons: [{ reason: "no text in the file", count: 1 }] });
    expect(fileIndex.retrySkipped()).toBe(0);
  });

  it("reads the media option per file, so a setting turned on later applies", async () => {
    writeFileSync(join(scans, "receipt.png"), "not really a png");
    let media: MediaTextOptions | undefined;
    const fileIndex = open({ ocr: { engine }, media: () => media });
    await fileIndex.addFolder(scans);
    await fileIndex.idle();
    expect(fileIndex.status().skippedReasons).toEqual([{ reason: "disabled", count: 1 }]);
    // On, but no vision model: still skipped, now saying so.
    media = { enabled: true };
    expect(fileIndex.retrySkipped()).toBe(1);
    await fileIndex.idle();
    expect(fileIndex.status().skippedReasons).toEqual([{ reason: "no-vision-model: no vision provider configured", count: 1 }]);
  });
});

describe("isRetryableSkip", () => {
  it("retries a missing or failed reader, never a file that has nothing to read", () => {
    for (const reason of [
      "scan: OCR not available (no vision model is configured)",
      "scan: OCR failed (timeout)",
      "disabled",
      "no-vision-model: no vision provider configured",
      "no-engine: whisper.cpp not found",
      'needs-model-download: speech model "base" (142 MB) is not downloaded yet',
      "needs-ffmpeg",
    ]) {
      expect(isRetryableSkip(reason), reason).toBe(true);
    }
    for (const reason of [
      "unsupported file type",
      "larger than 52428800 bytes",
      "no text in the file",
      "scan: OCR found no text",
      "too-large: 1 bytes > 0",
    ]) {
      expect(isRetryableSkip(reason), reason).toBe(false);
    }
  });
});
