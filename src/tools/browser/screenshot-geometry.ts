/**
 * Size rules for `browser.screenshot` (ATO-515). Pure, so the caps are
 * unit-tested without a browser.
 *
 * - The long side of the image is at most {@link BROWSER_SHOT_MAX_SIDE}
 *   pixels (never upscaled): enough to read a page, small enough for a
 *   vision model's input.
 * - A full-page shot covers at most {@link FULL_PAGE_MAX_CSS_HEIGHT} CSS
 *   pixels from the top; the rest is cut (`clipped`).
 * - The JPEG is at most {@link BROWSER_SHOT_MAX_BYTES}; a larger first
 *   attempt is retaken smaller and at lower quality, then refused.
 */
export const BROWSER_SHOT_MAX_SIDE = 1280;
export const FULL_PAGE_MAX_CSS_HEIGHT = 8_000;
export const BROWSER_SHOT_MAX_BYTES = 900_000;

/** Quality and long side per attempt; the last one that fits wins. */
export const SHOT_ATTEMPTS: ReadonlyArray<{ quality: number; maxSide: number }> = [
  { quality: 70, maxSide: BROWSER_SHOT_MAX_SIDE },
  { quality: 50, maxSide: 960 },
  { quality: 40, maxSide: 640 },
];

export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShotPlan {
  /** Region in document CSS pixels (CDP `clip`). */
  clip: CssRect;
  /** CDP `clip.scale`: 1 or less. */
  scale: number;
  /** Output image size in pixels. */
  width: number;
  height: number;
  /** A full-page shot was cut at the height cap. */
  clipped: boolean;
}

/**
 * Plan one capture of `rect` (document CSS pixels) so its long side in
 * device pixels is at most `maxSide`. `fullPage` caps the height first.
 * `null` for an empty region (a hidden or zero-size element).
 */
export function planShot(
  rect: CssRect,
  devicePixelRatio: number,
  maxSide: number,
  fullPage = false,
): ShotPlan | null {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const width = Math.floor(rect.width);
  let height = Math.floor(rect.height);
  let clipped = false;
  if (fullPage && height > FULL_PAGE_MAX_CSS_HEIGHT) {
    height = FULL_PAGE_MAX_CSS_HEIGHT;
    clipped = true;
  }
  if (width < 1 || height < 1) return null;
  const long = Math.max(width, height) * dpr;
  const scale = Math.min(1, maxSide / long);
  return {
    clip: { x: Math.max(0, Math.floor(rect.x)), y: Math.max(0, Math.floor(rect.y)), width, height },
    scale,
    width: Math.max(1, Math.round(width * dpr * scale)),
    height: Math.max(1, Math.round(height * dpr * scale)),
    clipped,
  };
}
