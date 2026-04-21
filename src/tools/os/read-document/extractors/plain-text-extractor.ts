import type { Extractor } from "./extractor-types.js";

/**
 * Pass-through extractor for text-like files (txt, md, log, csv, html…).
 * We try UTF-8 first; if it produces U+FFFD replacement characters we fall
 * back to latin1 so the caller still gets useful text instead of a mojibake
 * soup. Any decode fallback is announced via `warnings`.
 */
export const plainTextExtractor: Extractor = async (input) => {
  const warnings: string[] = [];
  let text = input.data.toString("utf8");
  if (text.includes("\uFFFD")) {
    const latin = input.data.toString("latin1");
    if (!latin.includes("\uFFFD")) {
      text = latin;
      warnings.push(
        "decoded with latin1 fallback: UTF-8 yielded replacement characters",
      );
    } else {
      warnings.push("UTF-8 decode produced replacement characters");
    }
  }
  // Normalise Windows line endings so downstream logic (and the LLM) sees
  // one canonical form.
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return {
    format: "plain",
    text,
    warnings,
  };
};
