/**
 * Pad or ellipsise a string to exactly `width` cells.
 *
 * Load-bearing for every floating panel in the app. Terminals have no
 * compositing and Ink has no z-index, so an overlay occludes what is
 * under it only by painting every one of its own cells — a row that
 * stops at its content lets the backdrop show through the gap. Ink's own
 * `paddingX` does not help: it leaves real gaps rather than painted
 * ones, which is why the gutter is baked into the string instead.
 */
export function fitToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length > width) {
    return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
  }
  return text.padEnd(width);
}
