import type { Rgb } from "./parse-hex-color.js";

/**
 * Relative luminance on 0..255 channels, normalized once.
 *
 * Two callers ask the same question of the same weights: the OSC 11
 * probe deciding whether the whole terminal is light or dark, and the
 * composer chip deciding which ink survives on the ground it is about to
 * paint. Keeping one copy means they can never disagree about where the
 * midpoint is.
 */
export function luminance(rgb: Rgb): number {
  return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
}
