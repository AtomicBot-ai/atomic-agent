/**
 * Hex colour parsing for the palette layer.
 *
 * Split out of `detect-terminal-background.ts`, which needed it to
 * classify an OSC 11 reply and kept a private copy. Anything that has to
 * *compute* with a palette colour — mix two of them, weigh one's
 * luminance — needs the same three integers, and two parsers that
 * disagree about `#abc` would be a bug nobody would think to look for.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Parse `#rrggbb` or `#rgb` (with or without the leading `#`). Returns
 * `null` for anything else — callers decide what a colour they cannot
 * read should fall back to, because "black" is a terrible default for a
 * background and a fine one for text.
 */
export function parseHexColor(value: string): Rgb | null {
  const hex = value.startsWith("#") ? value.slice(1) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  if (hex.length === 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  if (hex.length === 3) {
    const r = hex.slice(0, 1);
    const g = hex.slice(1, 2);
    const b = hex.slice(2, 3);
    return {
      r: parseInt(r + r, 16),
      g: parseInt(g + g, 16),
      b: parseInt(b + b, 16),
    };
  }
  return null;
}

/** Render back to the `#rrggbb` form every Ink colour prop accepts. */
export function formatHexColor(rgb: Rgb): string {
  const channel = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}
