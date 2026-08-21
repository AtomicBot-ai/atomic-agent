/**
 * The app's one progress bar: `====    ` at a fixed width.
 *
 * It was written twice, byte for byte, in `llm-panel.tsx` and
 * `local-models-panel.tsx` — and the composer's context chip would have
 * made three. A terminal has one honest way to draw a fill, and every
 * surface that draws one should draw the same one, or the panels start
 * to look like screenshots from different applications.
 *
 * `=` rather than a block glyph on purpose: the panels ship inside a
 * `[...]` bracket, and box-drawing blocks render at inconsistent widths
 * on the terminals this runs on.
 */
export function renderProgressBar(percent: number, width: number): string {
  const filled = Math.min(width, Math.round((percent / 100) * width));
  return "=".repeat(filled) + " ".repeat(Math.max(0, width - filled));
}
