import { highlight, supportsLanguage } from "cli-highlight";

const MAX_HIGHLIGHT_LENGTH = 10_000;

/**
 * Best-effort ANSI syntax highlighting for fenced code blocks. Falls
 * back to raw text when the language is unknown, the snippet exceeds a
 * safety ceiling, or the highlighter throws. Ink's `<Text>` preserves
 * ANSI escapes written by `cli-highlight`, so the result renders with
 * coloured tokens inline.
 */
export function highlightCodeBlock(code: string, language: string): string {
  if (code.length === 0) return code;
  if (code.length > MAX_HIGHLIGHT_LENGTH) return code;
  const lang = language.trim().toLowerCase();
  if (lang.length === 0 || !supportsLanguage(lang)) return code;
  try {
    return highlight(code, { language: lang, ignoreIllegals: true });
  } catch {
    return code;
  }
}
