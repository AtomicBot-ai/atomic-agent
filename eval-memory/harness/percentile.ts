/**
 * Sample-percentile helpers used by experiment summaries (LoCoMo +
 * future benchmarks). Implements the canonical "type 7" linear
 * interpolation matching `numpy.percentile`'s default and R's
 * `quantile(... type=7)`. This is the convention papers and ops
 * dashboards expect; do not switch to nearest-rank without a campaign
 * scorecard update.
 *
 * All helpers are pure — they sort an internal copy of the input and
 * never mutate the caller's array.
 */

/**
 * Return the `fraction`-percentile (0..1) of `xs` using linear
 * interpolation between adjacent ranks. Empty input ⇒ 0.
 *
 * Examples:
 *   percentile([1, 2, 3, 4], 0.5)   === 2.5
 *   percentile([1, 2, 3, 4], 0.95)  === 3.85
 *   percentile([42], 0.5)           === 42
 *   percentile([], 0.5)             === 0
 */
export function percentile(xs: readonly number[], fraction: number): number {
  if (xs.length === 0) return 0;
  if (fraction <= 0) return Math.min(...xs);
  if (fraction >= 1) return Math.max(...xs);
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const h = (n - 1) * fraction;
  const floorH = Math.floor(h);
  const ceilH = Math.min(floorH + 1, n - 1);
  const frac = h - floorH;
  return sorted[floorH] + frac * (sorted[ceilH] - sorted[floorH]);
}

/**
 * Convenience triple commonly reported in summaries: mean, p50, p95.
 * Empty input ⇒ all-zero triple so caller never needs to branch.
 */
export interface MeanP50P95 {
  mean: number;
  p50: number;
  p95: number;
}

export function meanP50P95(xs: readonly number[]): MeanP50P95 {
  if (xs.length === 0) return { mean: 0, p50: 0, p95: 0 };
  let sum = 0;
  for (const x of xs) sum += x;
  const mean = sum / xs.length;
  return {
    mean,
    p50: percentile(xs, 0.5),
    p95: percentile(xs, 0.95),
  };
}
