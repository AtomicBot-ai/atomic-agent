/**
 * Bootstrap-resampled confidence intervals for small-N metrics. Used
 * by the multi-run wrapper to surface "is this profile actually
 * better than that one, or is it noise?" without forcing the
 * publisher to argue normality assumptions on N=3 means.
 *
 * The algorithm is textbook percentile bootstrap:
 *
 *   1. Given a sample x[0..n-1], draw `iterations` resamples of
 *      size n WITH replacement.
 *   2. Compute the statistic (default: mean) on each resample.
 *   3. The CI is the [alpha/2, 1-alpha/2] percentiles of the
 *      bootstrap distribution.
 *
 * Default iterations = 2000 (publication-acceptable; trades a few ms
 * for noticeably tighter CIs than the conventional 1000). Deterministic
 * when callers pass a seeded RNG; uses Math.random by default.
 *
 * For comparing two profiles (A vs B), use `bootstrapDelta` which
 * resamples the per-trial deltas — this is the right shape when the
 * two arms are evaluated on the **same** scenario (paired design),
 * which is exactly what `runCampaignScenario` produces across profiles.
 */

export type RngFn = () => number;

export interface BootstrapOptions {
  /** Number of resamples. Default 2000. */
  iterations?: number;
  /** Two-sided alpha. Default 0.05 (⇒ 95% CI). */
  alpha?: number;
  /** Custom RNG. Defaults to Math.random. */
  rng?: RngFn;
  /** Statistic to compute per resample. Defaults to arithmetic mean. */
  statistic?: (sample: readonly number[]) => number;
}

export interface BootstrapResult {
  /** Point estimate computed on the original sample. */
  point: number;
  /** Lower CI bound. */
  ciLow: number;
  /** Upper CI bound. */
  ciHigh: number;
  /** Number of resamples actually executed. */
  iterations: number;
  /** Original sample size. */
  n: number;
}

export function bootstrap(
  sample: readonly number[],
  opts: BootstrapOptions = {},
): BootstrapResult {
  const iterations = opts.iterations ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rng = opts.rng ?? Math.random;
  const stat = opts.statistic ?? mean;

  if (sample.length === 0) {
    return { point: 0, ciLow: 0, ciHigh: 0, iterations: 0, n: 0 };
  }
  if (sample.length === 1) {
    const v = sample[0]!;
    return { point: v, ciLow: v, ciHigh: v, iterations: 0, n: 1 };
  }

  const point = stat(sample);
  const draws: number[] = new Array(iterations);
  const n = sample.length;
  for (let i = 0; i < iterations; i += 1) {
    const resample: number[] = new Array(n);
    for (let j = 0; j < n; j += 1) {
      const pick = Math.floor(rng() * n);
      // Defensive: if RNG returns exactly 1.0, pick may equal n.
      resample[j] = sample[Math.min(pick, n - 1)]!;
    }
    draws[i] = stat(resample);
  }
  draws.sort((a, b) => a - b);
  const lowIdx = Math.floor((alpha / 2) * iterations);
  const highIdx = Math.min(
    iterations - 1,
    Math.ceil((1 - alpha / 2) * iterations) - 1,
  );
  return {
    point,
    ciLow: draws[lowIdx]!,
    ciHigh: draws[highIdx]!,
    iterations,
    n,
  };
}

/**
 * Bootstrap the mean delta (a[i] - b[i]) for a **paired** sample where
 * arm A and arm B were evaluated on the same set of trials. Returns a
 * CI; when `0` falls outside the CI the difference is "statistically
 * detectable" at the chosen alpha. Pairs with `null` (missing arm) are
 * dropped at the input boundary, so the caller decides whether to
 * impute or skip.
 */
export function bootstrapDelta(
  a: readonly number[],
  b: readonly number[],
  opts: BootstrapOptions = {},
): BootstrapResult {
  if (a.length !== b.length) {
    throw new Error(
      `bootstrapDelta: paired samples must be equal length (got ${a.length} vs ${b.length})`,
    );
  }
  const deltas: number[] = new Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    deltas[i] = (a[i] ?? 0) - (b[i] ?? 0);
  }
  return bootstrap(deltas, opts);
}

export function mean(sample: readonly number[]): number {
  if (sample.length === 0) return 0;
  let sum = 0;
  for (const x of sample) sum += x;
  return sum / sample.length;
}

/**
 * Tiny seeded PRNG (Mulberry32) for deterministic tests. Returns a
 * function shaped like `Math.random`. Same seed always yields the
 * same sequence — essential for asserting CI bounds in tests.
 */
export function seededRng(seed: number): RngFn {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
