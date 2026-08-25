import { formatHexColor, parseHexColor } from "./parse-hex-color.js";

/**
 * Blend two palette colours in linear channel space.
 *
 * The point is to derive a *ramp* from tokens the palette already
 * defines instead of hard-coding a second and third accent into every
 * one of them. Mixing an accent toward the ground it sits on is the one
 * operation that means the same thing on a light theme and a dark one:
 * on `classic-light` a half-mix of deep blue and a pale grey rail is
 * literally pale blue, on `khorne-red` a blood red pulled toward its
 * dark rail is a quiet dimmed red, and both read as "this control is
 * not shouting yet".
 *
 * Channel-space (not perceptual) mixing is deliberate: it is what a
 * terminal's 24-bit colour is, the inputs are all mid-saturation palette
 * colours rather than extremes, and the result is checked by a contrast
 * test rather than by eye.
 *
 * `t` is the share of `b`: `0` returns `a`, `1` returns `b`. Out-of-range
 * values are clamped. An unparseable input returns `a` untouched — a
 * colour that cannot be read is not worth crashing a render over.
 */
export function mixColor(a: string, b: string, t: number): string {
  const from = parseHexColor(a);
  const to = parseHexColor(b);
  if (!from || !to) return a;
  const ratio = Math.max(0, Math.min(1, t));
  return formatHexColor({
    r: from.r + (to.r - from.r) * ratio,
    g: from.g + (to.g - from.g) * ratio,
    b: from.b + (to.b - from.b) * ratio,
  });
}
