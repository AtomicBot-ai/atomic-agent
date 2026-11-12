import { parseHexColor, type Rgb } from "../theme/parse-hex-color.js";

/** How many colours the terminal can show: 24-bit or the xterm 256 palette. */
export type AnsiColorDepth = "truecolor" | "256";

const TRUECOLOR_PROGRAMS = new Set([
  "iTerm.app",
  "WezTerm",
  "vscode",
  "ghostty",
  "Hyper",
  "Tabby",
]);

/**
 * Pick the colour depth from the environment. Theme colours are 24-bit
 * hex, but a terminal that only speaks 256 colours (macOS Terminal.app
 * before 26, tmux without `Tc`) shows a 24-bit escape as noise or a
 * wrong colour, so anything we cannot confirm as truecolor gets the
 * nearest 256-palette colour instead.
 */
export function detectAnsiColorDepth(
  env: NodeJS.ProcessEnv = process.env,
): AnsiColorDepth {
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if (env.WT_SESSION) return "truecolor";
  if (env.TERM_PROGRAM && TRUECOLOR_PROGRAMS.has(env.TERM_PROGRAM)) {
    return "truecolor";
  }
  return "256";
}

const CUBE_STEPS: readonly number[] = [0, 95, 135, 175, 215, 255];

function cubeStep(index: number): number {
  return CUBE_STEPS[index] ?? 0;
}

function nearestCubeIndex(channel: number): number {
  let best = 0;
  for (let i = 1; i < CUBE_STEPS.length; i++) {
    if (Math.abs(cubeStep(i) - channel) < Math.abs(cubeStep(best) - channel)) {
      best = i;
    }
  }
  return best;
}

function distance(a: Rgb, b: Rgb): number {
  return (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
}

/** Nearest xterm-256 index (colour cube or grey ramp) for an RGB colour. */
export function rgbToAnsi256(rgb: Rgb): number {
  const ri = nearestCubeIndex(rgb.r);
  const gi = nearestCubeIndex(rgb.g);
  const bi = nearestCubeIndex(rgb.b);
  const cube: Rgb = { r: cubeStep(ri), g: cubeStep(gi), b: cubeStep(bi) };
  const avg = Math.round((rgb.r + rgb.g + rgb.b) / 3);
  const greyIndex = Math.min(23, Math.max(0, Math.round((avg - 8) / 10)));
  const greyLevel = 8 + greyIndex * 10;
  const grey: Rgb = { r: greyLevel, g: greyLevel, b: greyLevel };
  return distance(rgb, grey) < distance(rgb, cube)
    ? 232 + greyIndex
    : 16 + 36 * ri + 6 * gi + bi;
}

/**
 * The SGR "set foreground" sequence for a hex colour, or `""` when the
 * value is not a colour we can parse (the token then keeps the default
 * ink). Close it with {@link ANSI_FG_RESET}.
 */
export function ansiForeground(hex: string, depth: AnsiColorDepth): string {
  // Themes may carry an alpha channel (#rrggbbaa); the terminal cannot
  // blend it, so it is dropped and the colour drawn opaque.
  const opaque = /^#?[0-9a-f]{8}$/i.test(hex) ? hex.slice(0, -2) : hex;
  const rgb = parseHexColor(opaque);
  if (!rgb) return "";
  return depth === "truecolor"
    ? `\u001b[38;2;${rgb.r};${rgb.g};${rgb.b}m`
    : `\u001b[38;5;${rgbToAnsi256(rgb)}m`;
}

export const ANSI_FG_RESET = "\u001b[39m";
export const ANSI_BOLD = "\u001b[1m";
export const ANSI_BOLD_RESET = "\u001b[22m";
export const ANSI_ITALIC = "\u001b[3m";
export const ANSI_ITALIC_RESET = "\u001b[23m";
export const ANSI_UNDERLINE = "\u001b[4m";
export const ANSI_UNDERLINE_RESET = "\u001b[24m";
