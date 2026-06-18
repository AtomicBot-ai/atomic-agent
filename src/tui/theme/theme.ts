/**
 * Central colour + glyph palette for the Ink-based TUI. Avoids scattering
 * `color="cyan"` literals across components and keeps the visual language
 * consistent with openclaw's theme contract.
 *
 * Colours are Ink colour names (see https://github.com/vadimdemedes/ink#color).
 * Glyphs are single Unicode code points that render consistently on macOS
 * Terminal, iTerm2, Windows Terminal and Alacritty.
 */

export interface TuiColors {
  readonly user: string;
  readonly assistant: string;
  readonly system: string;
  readonly reasoning: string;
  readonly tool: string;
  readonly toolOk: string;
  readonly toolError: string;
  readonly accent: string;
  readonly accentSoft: string;
  readonly border: string;
  readonly muted: string;
  readonly error: string;
  readonly warn: string;
  /** Stronger warn accent (orange) for high-visibility badges. */
  readonly warnStrong: string;
  readonly success: string;
  readonly info: string;
}

export interface TuiGlyphs {
  readonly userMarker: string;
  readonly assistantMarker: string;
  readonly systemMarker: string;
  readonly reasoningMarker: string;
  readonly toolBoxTopLeft: string;
  readonly toolBoxTopRight: string;
  readonly toolBoxBottomLeft: string;
  readonly toolBoxBottomRight: string;
  readonly toolBoxHorizontal: string;
  readonly toolBoxVertical: string;
  readonly bullet: string;
  readonly arrowRight: string;
  readonly arrowLeft: string;
  readonly check: string;
  readonly cross: string;
  readonly warn: string;
  readonly info: string;
  readonly ellipsis: string;
  readonly promptCaret: string;
  readonly chevronRight: string;
  readonly dotSeparator: string;
  readonly pipeSeparator: string;
}

export interface TuiTheme {
  readonly colors: TuiColors;
  readonly glyphs: TuiGlyphs;
  readonly spinnerFrames: readonly string[];
  readonly spinnerFrameMs: number;
}

const COLORS: TuiColors = {
  // Bright variants for the bubble ribbon. The "blue" terminal slot on
  // most dark macOS / Linux themes is almost invisible against the
  // default background — the user reads the ribbon as "messages
  // touching" instead of "blue / green role indicator". Bright slots
  // are the same hue but sit several stops higher in luminance and
  // survive every default theme we tested.
  user: "blueBright",
  assistant: "greenBright",
  system: "gray",
  reasoning: "magentaBright",
  tool: "blueBright",
  toolOk: "greenBright",
  toolError: "red",
  accent: "blueBright",
  accentSoft: "blueBright",
  border: "gray",
  muted: "gray",
  error: "red",
  warn: "yellow",
  warnStrong: "#FF8800",
  success: "greenBright",
  info: "blueBright",
};

const GLYPHS: TuiGlyphs = {
  userMarker: "›",
  assistantMarker: "●",
  systemMarker: "·",
  reasoningMarker: "◈",
  toolBoxTopLeft: "┌",
  toolBoxTopRight: "┐",
  toolBoxBottomLeft: "└",
  toolBoxBottomRight: "┘",
  toolBoxHorizontal: "─",
  toolBoxVertical: "│",
  bullet: "•",
  arrowRight: "→",
  arrowLeft: "←",
  check: "✓",
  cross: "✗",
  warn: "⚠",
  info: "ℹ",
  ellipsis: "…",
  promptCaret: "❯",
  chevronRight: "▸",
  dotSeparator: "·",
  pipeSeparator: "|",
};

const SPINNER_FRAMES: readonly string[] = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

export const theme: TuiTheme = {
  colors: COLORS,
  glyphs: GLYPHS,
  spinnerFrames: SPINNER_FRAMES,
  spinnerFrameMs: 120,
};
