import {
  createHighlighterCoreSync,
  type HighlighterCore,
  type ThemedToken,
} from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import darkPlus from "@shikijs/themes/dark-plus";
import lightPlus from "@shikijs/themes/light-plus";
import { luminance } from "../theme/color-luminance.js";
import { parseHexColor } from "../theme/parse-hex-color.js";
import { getActiveThemeName } from "../theme/theme.js";
import { CANONICAL_PAGE } from "../theme/theme-palettes.js";
import {
  ANSI_BOLD,
  ANSI_BOLD_RESET,
  ANSI_FG_RESET,
  ANSI_ITALIC,
  ANSI_ITALIC_RESET,
  ANSI_UNDERLINE,
  ANSI_UNDERLINE_RESET,
  ansiForeground,
  detectAnsiColorDepth,
  type AnsiColorDepth,
} from "./ansi-color.js";
import { SHIKI_GRAMMARS } from "./shiki-languages.js";

/**
 * ATO-653: VS Code grammars for terminal code blocks.
 *
 * Built synchronously from statically imported grammars and the pure-JS
 * regex engine (no Oniguruma WASM, nothing fetched). Synchronous on
 * purpose: a code block is coloured while Ink renders it, and a reply
 * already written to the scrollback is never re-rendered, so a
 * highlighter that became ready "a moment later" would leave every
 * block drawn before that moment grey for good.
 *
 * Creating the highlighter only registers grammars; their regexes are
 * compiled on first use, per grammar. That first TS block costs some
 * milliseconds more than later ones.
 */

/** VS Code's default themes, picked by the TUI palette's own page colour. */
export const SHIKI_DARK_THEME = "dark-plus";
export const SHIKI_LIGHT_THEME = "light-plus";

/** Longest line we tokenize; a longer one (minified JS) is left plain. */
const MAX_LINE_LENGTH = 2_000;
/** Per-line tokenizer budget, so one pathological line cannot stall a frame. */
const LINE_TIME_LIMIT_MS = 100;
/** Ink redraws a finished block on every frame; keep its colouring. */
const CACHE_LIMIT = 32;

// Token font-style bits (vscode-textmate `FontStyle`).
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

let highlighter: HighlighterCore | null = null;
let highlighterFailed = false;
const cache = new Map<string, string>();

function getHighlighter(): HighlighterCore | null {
  if (highlighter || highlighterFailed) return highlighter;
  try {
    highlighter = createHighlighterCoreSync({
      engine: createJavaScriptRegexEngine({ forgiving: true }),
      themes: [darkPlus, lightPlus],
      langs: [...SHIKI_GRAMMARS],
    });
  } catch {
    highlighterFailed = true;
  }
  return highlighter;
}

/** The shiki theme that matches the active TUI palette (light page or dark). */
export function shikiThemeForActivePalette(): string {
  const page = CANONICAL_PAGE[getActiveThemeName()];
  const rgb = page ? parseHexColor(page) : null;
  return rgb && luminance(rgb) > 0.5 ? SHIKI_LIGHT_THEME : SHIKI_DARK_THEME;
}

function styleToken(
  token: ThemedToken,
  defaultFg: string,
  depth: AnsiColorDepth,
): string {
  let open = "";
  let close = "";
  const color = token.color;
  // The theme's plain-text colour is left to the terminal, so identifiers
  // and punctuation keep the TUI palette's own ink.
  if (color && color.toLowerCase() !== defaultFg) {
    const fg = ansiForeground(color, depth);
    if (fg) {
      open += fg;
      close = ANSI_FG_RESET + close;
    }
  }
  const style = token.fontStyle ?? 0;
  if (style > 0 && style & BOLD) {
    open += ANSI_BOLD;
    close = ANSI_BOLD_RESET + close;
  }
  if (style > 0 && style & ITALIC) {
    open += ANSI_ITALIC;
    close = ANSI_ITALIC_RESET + close;
  }
  if (style > 0 && style & UNDERLINE) {
    open += ANSI_UNDERLINE;
    close = ANSI_UNDERLINE_RESET + close;
  }
  return open.length > 0 ? open + token.content + close : token.content;
}

/** Render shiki's token lines as ANSI, one self-contained line per row. */
export function tokensToAnsi(
  lines: readonly (readonly ThemedToken[])[],
  defaultFg: string,
  depth: AnsiColorDepth,
): string {
  const fg = defaultFg.toLowerCase();
  return lines
    .map((line) => line.map((token) => styleToken(token, fg, depth)).join(""))
    .join("\n");
}

function remember(key: string, value: string): string {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

/**
 * Colour `code` as `shikiLang` (an id from shiki-languages.ts). Returns
 * `null` when shiki cannot do it (highlighter failed to build, grammar
 * missing, tokenizer threw) so the caller can fall back.
 */
export function highlightWithShiki(
  code: string,
  shikiLang: string,
): string | null {
  const hl = getHighlighter();
  if (!hl) return null;
  const theme = shikiThemeForActivePalette();
  const depth = detectAnsiColorDepth();
  const key = `${theme}\u0000${depth}\u0000${shikiLang}\u0000${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  try {
    const lines = hl.codeToTokensBase(code, {
      lang: shikiLang,
      theme,
      tokenizeMaxLineLength: MAX_LINE_LENGTH,
      tokenizeTimeLimit: LINE_TIME_LIMIT_MS,
    });
    const defaultFg = hl.getTheme(theme).fg;
    return remember(key, tokensToAnsi(lines, defaultFg, depth));
  } catch {
    return null;
  }
}

/** Test seam: forget the built highlighter and the cached results. */
export function resetShikiHighlighterForTests(): void {
  highlighter = null;
  highlighterFailed = false;
  cache.clear();
}
