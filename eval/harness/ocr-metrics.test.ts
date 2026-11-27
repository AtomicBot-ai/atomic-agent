import { describe, expect, it } from "vitest";

import { editDistance, normaliseOcrText, ocrAccuracy, ocrBenchMarkdown, summariseOcrBench, type OcrBenchRow } from "./ocr-metrics.js";

// ATO-2502: the error rates the Russian-scan benchmark reports.
describe("normaliseOcrText", () => {
  it("drops layout noise but keeps case, punctuation and ё", () => {
    expect(normaliseOcrText("--- page 1 ---\nДоговор  аренды,\n\tстра­ница 1\n--- page 2 ---\nЁлка")).toBe("Договор аренды, страница 1 Ёлка");
  });
});

describe("editDistance", () => {
  it("counts inserts, deletes and substitutions", () => {
    expect(editDistance([..."kitten"], [..."sitting"])).toBe(3);
    expect(editDistance([], [..."abc"])).toBe(3);
    expect(editDistance(["a", "b"], ["a", "b"])).toBe(0);
  });
});

describe("ocrAccuracy", () => {
  it("is 0 for a perfect read and counts Cyrillic letters as single characters", () => {
    expect(ocrAccuracy("Договор аренды", "Договор\nаренды")).toMatchObject({ cer: 0, wer: 0, referenceChars: 14, referenceWords: 2 });
    const one = ocrAccuracy("Договор аренды", "Договор аренды!");
    expect(one.cer).toBeCloseTo(1 / 14);
    expect(one.wer).toBeCloseTo(1 / 2);
  });

  it("reads an empty result as all wrong", () => {
    expect(ocrAccuracy("Договор", "")).toMatchObject({ cer: 1, wer: 1 });
    expect(ocrAccuracy("", "")).toMatchObject({ cer: 0, wer: 0 });
  });
});

describe("summariseOcrBench", () => {
  const rows: OcrBenchRow[] = [
    { file: "a.pdf", engine: "tesseract-js", pages: 2, ocrPages: 2, seconds: 4, cer: 0.1, wer: 0.2 },
    { file: "b.pdf", engine: "tesseract-js", pages: 1, ocrPages: 1, seconds: 2, cer: 0.4, wer: 0.5 },
    { file: "a.pdf", engine: "vision-model", pages: 2, ocrPages: 0, seconds: 1, cer: null, wer: null, error: "no vision model" },
  ];
  const refs = new Map([
    ["a.pdf", { chars: 300, words: 50 }],
    ["b.pdf", { chars: 100, words: 50 }],
  ]);

  it("weights error rates by reference length and counts failures apart", () => {
    const [tesseract, vision] = summariseOcrBench(rows, refs);
    expect(tesseract).toMatchObject({ engine: "tesseract-js", files: 2, failed: 0, pages: 3, secondsPerPage: 2 });
    expect(tesseract!.cer).toBeCloseTo((0.1 * 300 + 0.4 * 100) / 400);
    expect(tesseract!.wer).toBeCloseTo((0.2 * 50 + 0.5 * 50) / 100);
    expect(vision).toMatchObject({ engine: "vision-model", files: 1, failed: 1, pages: 0, secondsPerPage: null, cer: null, wer: null });
  });

  it("renders a Markdown table", () => {
    const table = ocrBenchMarkdown(summariseOcrBench(rows, refs));
    expect(table).toContain("| tesseract-js | 2 | 0 | 3 | 17.5% | 35.0% | 2.00 |");
    expect(table).toContain("| vision-model | 1 | 1 | 0 | n/a | n/a | n/a |");
  });
});
