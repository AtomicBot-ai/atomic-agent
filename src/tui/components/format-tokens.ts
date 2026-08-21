/**
 * Token counts at terminal width: `6400` -> `6.4k`, `32000` -> `32k`,
 * `1000000` -> `1.0M`.
 *
 * Six significant digits are noise in a chip that has twenty-odd cells
 * to spend, and a round thousand reads better without the `.0` it would
 * otherwise carry. Shared by the composer's chip and its detail panel so
 * the same number never appears in two forms one keystroke apart.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) {
    const k = tokens / 1000;
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  const m = tokens / 1_000_000;
  return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
}
