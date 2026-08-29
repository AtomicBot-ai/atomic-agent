import { parseHexColor, type Rgb } from "./parse-hex-color.js";

/**
 * WCAG 2.x relative luminance, with the sRGB transfer curve.
 *
 * Distinct from the perceived-brightness average in
 * `color-luminance.ts`, which answers a coarser question ("is this
 * terminal light or dark?") and is fine for it. Choosing ink for a chip
 * is a contrast question, and the cheap average gets it wrong exactly
 * where it matters — around the midpoint, which is where a colour ramp
 * spends its middle step.
 */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Contrast ratio between two colours, 1 (identical) to 21 (black on
 * white). WCAG AA wants 4.5 for body text. Returns `1` — the worst
 * possible answer — when either colour cannot be parsed, so an
 * unreadable input can never win a "pick the better one" comparison.
 */
export function contrastRatio(a: string, b: string): number {
  const first = parseHexColor(a);
  const second = parseHexColor(b);
  if (!first || !second) return 1;
  const one = relativeLuminance(first);
  const two = relativeLuminance(second);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}
