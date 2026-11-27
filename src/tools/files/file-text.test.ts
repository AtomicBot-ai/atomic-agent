import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OcrEngine, OcrPageRequest } from "../os/read-document/index.js";
import { buildTestPdf } from "../os/read-document/extractors/scan-pdf-test-helpers.js";
import { DEFAULT_MAX_OCR_PAGES, extractFileText } from "./file-text.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-file-text-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A scanned PDF: every page one image, no text layer. */
function scanPdf(pages: number): string {
  const path = join(dir, "scan.pdf");
  writeFileSync(path, buildTestPdf(Array.from({ length: pages }, () => ({ image: { width: 200, height: 260 } }))));
  return path;
}

function fakeEngine(over: Partial<OcrEngine> = {}) {
  const seen: OcrPageRequest[] = [];
  const engine: OcrEngine = {
    id: "fake-ocr",
    unavailableReason: async () => undefined,
    recognizePdfPages: async (request) => {
      seen.push(request);
      return {
        pages: request.pages.map((page) => ({ page, text: `Lease agreement page ${page}: rent is due on the fifth` })),
        warnings: [],
      };
    },
    ...over,
  };
  return { engine, seen };
}

describe("extractFileText: scanned PDFs (ATO-2205)", () => {
  it("sends the scanned pages to the OCR engine and keeps each page's number", async () => {
    const path = scanPdf(2);
    const { engine, seen } = fakeEngine();
    const result = await extractFileText(path, { ocr: { engine } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.pages).toEqual([1, 2]);
    expect(seen[0]?.languages).toEqual(["rus", "eng"]);
    expect(result).toEqual({
      status: "ok",
      segments: [
        { page: 1, text: "Lease agreement page 1: rent is due on the fifth" },
        { page: 2, text: "Lease agreement page 2: rent is due on the fifth" },
      ],
    });
  });

  it("reads the engine through a getter per file", async () => {
    const { engine, seen } = fakeEngine();
    const getter = vi.fn(() => engine);
    await extractFileText(scanPdf(1), { ocr: { engine: getter } });
    expect(getter).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });

  it("honours the per-file page limit: later pages are not sent and not indexed", async () => {
    const { engine, seen } = fakeEngine();
    const result = await extractFileText(scanPdf(5), { ocr: { engine, maxPages: 2 } });
    expect(seen[0]?.pages).toEqual([1, 2]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.segments.map((s) => s.page)).toEqual([1, 2]);
    expect(DEFAULT_MAX_OCR_PAGES).toBe(30);
  });

  it("passes the index's abort signal to the engine", async () => {
    const { engine, seen } = fakeEngine();
    const controller = new AbortController();
    await extractFileText(scanPdf(1), { ocr: { engine }, signal: controller.signal });
    expect(seen[0]?.signal).toBe(controller.signal);
  });

  it("without an engine skips the scan with a clear reason", async () => {
    const result = await extractFileText(scanPdf(1));
    expect(result).toEqual({ status: "skipped", reason: "scan: OCR not available (no OCR engine is set up for the file index)" });
  });

  it("with an engine that cannot run skips with the engine's reason and never calls it", async () => {
    const recognizePdfPages = vi.fn();
    const { engine } = fakeEngine({ unavailableReason: async () => "no vision model is configured", recognizePdfPages });
    const result = await extractFileText(scanPdf(1), { ocr: { engine } });
    expect(result).toEqual({ status: "skipped", reason: "scan: OCR not available (no vision model is configured)" });
    expect(recognizePdfPages).not.toHaveBeenCalled();
  });

  it("an engine that throws leaves a skip with the error, not a crash", async () => {
    const { engine } = fakeEngine({
      recognizePdfPages: async () => {
        throw new Error("model server stopped");
      },
    });
    const result = await extractFileText(scanPdf(1), { ocr: { engine } });
    expect(result).toEqual({ status: "skipped", reason: "scan: OCR failed (model server stopped)" });
  });

  it("an engine that finds nothing says so", async () => {
    const { engine } = fakeEngine({ recognizePdfPages: async () => ({ pages: [], warnings: [] }) });
    const result = await extractFileText(scanPdf(1), { ocr: { engine } });
    expect(result).toEqual({ status: "skipped", reason: "scan: OCR found no text" });
  });

  it("leaves a PDF with a text layer as it was: the engine is not called", async () => {
    const path = join(dir, "digital.pdf");
    writeFileSync(path, buildTestPdf([{ text: "Invoice 77 total due 12500 RUB" }, { text: "Second page of the invoice text" }]));
    const recognizePdfPages = vi.fn();
    const { engine } = fakeEngine({ recognizePdfPages });
    const withEngine = await extractFileText(path, { ocr: { engine } });
    const without = await extractFileText(path);
    expect(recognizePdfPages).not.toHaveBeenCalled();
    expect(withEngine).toEqual(without);
    expect(withEngine).toEqual({
      status: "ok",
      segments: [
        { page: 1, text: expect.stringContaining("Invoice 77 total due 12500 RUB") },
        { page: 2, text: expect.stringContaining("Second page of the invoice text") },
      ],
    });
  });
});
