import type { OcrEngine } from "../read-document/extractors/ocr-engine.js";

/**
 * Several OCR engines behind one (ATO-2502): each file goes to the first
 * engine that is ready now, in the order given. The file index passes the
 * local vision model first and tesseract.js second, so a computer with no
 * vision model served still reads scans once tesseract.js and its data
 * are there, and one with both keeps today's engine until the Russian-scan
 * measurement says otherwise.
 *
 * When the chosen engine throws for the whole file (the model cannot take
 * images after all, the tesseract worker does not start), the next ready
 * engine gets the file; the last error is thrown when none read it.
 * Readiness is asked per file, so a model loaded or data downloaded later
 * applies from the next file on.
 */
export function createFallbackOcrEngine(engines: readonly OcrEngine[]): OcrEngine {
  if (engines.length === 0) throw new Error("createFallbackOcrEngine needs at least one engine");
  return {
    id: engines.map((engine) => engine.id).join(" or "),
    async unavailableReason(languages) {
      const reasons: string[] = [];
      for (const engine of engines) {
        const reason = await engine.unavailableReason(languages);
        if (reason === undefined) return undefined;
        reasons.push(reason);
      }
      return reasons.join("; ");
    },
    async recognizePdfPages(request) {
      let lastError: unknown;
      for (const engine of engines) {
        if ((await engine.unavailableReason(request.languages)) !== undefined) continue;
        try {
          return await engine.recognizePdfPages(request);
        } catch (err) {
          if (request.signal?.aborted) throw err;
          lastError = err;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("no OCR engine is ready");
    },
  };
}
