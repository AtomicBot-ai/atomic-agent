import { highlight, supportsLanguage } from "cli-highlight";
import { highlightWithShiki } from "./shiki-highlighter.js";
import { resolveShikiLanguage } from "./shiki-languages.js";

export const MAX_HIGHLIGHT_LENGTH = 10_000;

/**
 * Best-effort ANSI syntax highlighting for fenced code blocks. Ink's
 * `<Text>` preserves the ANSI escapes, so tokens render coloured inline.
 *
 * ATO-653: languages the bundled VS Code grammars cover (TS/TSX, JS,
 * Rust, Go, Python, shell, configs; see shiki-languages.ts) go through
 * shiki. Any other language still gets `cli-highlight`, and shiki
 * failing falls back to it too. Raw text when the language is unknown
 * to both, the snippet exceeds the safety ceiling, or highlighting throws.
 */
export function highlightCodeBlock(code: string, language: string): string {
  if (code.length === 0) return code;
  if (code.length > MAX_HIGHLIGHT_LENGTH) return code;
  const lang = language.trim().toLowerCase();
  if (lang.length === 0) return code;
  const shikiLang = resolveShikiLanguage(lang);
  if (shikiLang) {
    const coloured = highlightWithShiki(code, shikiLang);
    if (coloured !== null) return coloured;
  }
  return highlightWithCliHighlight(code, lang);
}

function highlightWithCliHighlight(code: string, lang: string): string {
  if (!supportsLanguage(lang)) return code;
  try {
    return highlight(code, { language: lang, ignoreIllegals: true });
  } catch {
    return code;
  }
}
