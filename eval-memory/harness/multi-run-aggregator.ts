/**
 * Multi-run aggregator. Given N independent runs of the same
 * (scenario, profile, dataset) tuple, this module:
 *
 *  1. Joins runs by a stable composite key (`profile::category` for
 *     LoCoMo, customisable for other experiments).
 *  2. Computes per-cell mean and 95% bootstrap CI **across runs** for
 *     each numeric metric the caller asks about.
 *  3. Returns a flat table the spec / orchestrator can write to CSV.
 *
 * The contract is intentionally generic — `bucketKey` and `numericKeys`
 * are caller-supplied so the same aggregator covers LoCoMo (key =
 * `${profile}::${category}`), LongMemEval (key = `${profile}::${axis}`),
 * and the procedure-distillation experiments without bespoke code.
 *
 * Across-runs vs within-run CI:
 *
 *  - Across-runs CI ("does this profile actually win, or is it noise
 *    between runs?") is what we report here. With N=3 runs the CI is
 *    wide; the operator should not over-interpret a single tight CI.
 *
 *  - Within-run CI (bootstrap across questions inside one run) is the
 *    other useful CI and is computed by `bootstrap()` directly on the
 *    NDJSON. The aggregator here does not touch that path so each
 *    layer stays independent.
 */

import { bootstrap, type BootstrapOptions } from "./bootstrap-ci.js";

export interface AggregatorRow {
  /** Composite bucket key, e.g. `"full_v2::single_hop"`. */
  key: string;
  /** Identity columns (`profile`, `category`, etc) parsed from `key` for the CSV. */
  identity: Readonly<Record<string, string>>;
  /** Per-metric `{ mean, ciLow, ciHigh, n }`. */
  metrics: Readonly<Record<string, MetricCI>>;
  /** Number of runs that contributed to this bucket. */
  contributingRuns: number;
}

export interface MetricCI {
  mean: number;
  ciLow: number;
  ciHigh: number;
  /** Bootstrap iterations actually executed. 0 for n<=1. */
  iterations: number;
  /** Number of run-level observations contributing to this metric. */
  n: number;
}

export interface MultiRunAggregatorInput<Row extends Record<string, unknown>> {
  /**
   * Each top-level element is one run's per-bucket summary. The
   * aggregator concatenates them flatwise; it does NOT care whether
   * a given key appears in every run (a profile that crashed in one
   * run is just absent there).
   */
  runs: ReadonlyArray<ReadonlyArray<Row>>;
  /** Produce the composite bucket key from a row (e.g. `${profile}::${category}`). */
  bucketKey: (row: Row) => string;
  /**
   * Identity columns to surface on the aggregated row (carried over
   * verbatim from the first run's row in that bucket). Typical use:
   * `["profile", "category"]`.
   */
  identityKeys: ReadonlyArray<keyof Row & string>;
  /** Numeric columns to aggregate (mean + CI). */
  numericKeys: ReadonlyArray<keyof Row & string>;
  /** Forwarded to bootstrap; defaults match the helper's own defaults. */
  bootstrapOptions?: BootstrapOptions;
}

export function aggregateMultiRun<Row extends Record<string, unknown>>(
  input: MultiRunAggregatorInput<Row>,
): AggregatorRow[] {
  const { runs, bucketKey, identityKeys, numericKeys, bootstrapOptions } =
    input;

  const byKey = new Map<
    string,
    {
      identity: Record<string, string>;
      metricSamples: Record<string, number[]>;
      contributingRuns: number;
    }
  >();

  for (const run of runs) {
    for (const row of run) {
      const key = bucketKey(row);
      let bucket = byKey.get(key);
      if (!bucket) {
        const identity: Record<string, string> = {};
        for (const k of identityKeys) {
          identity[k] = String(row[k] ?? "");
        }
        const metricSamples: Record<string, number[]> = {};
        for (const k of numericKeys) metricSamples[k] = [];
        bucket = { identity, metricSamples, contributingRuns: 0 };
        byKey.set(key, bucket);
      }
      bucket.contributingRuns += 1;
      for (const k of numericKeys) {
        const v = row[k];
        if (typeof v === "number" && Number.isFinite(v)) {
          bucket.metricSamples[k]!.push(v);
        }
      }
    }
  }

  const out: AggregatorRow[] = [];
  for (const [key, bucket] of byKey.entries()) {
    const metrics: Record<string, MetricCI> = {};
    for (const k of numericKeys) {
      const sample = bucket.metricSamples[k] ?? [];
      const r = bootstrap(sample, bootstrapOptions);
      metrics[k] = {
        mean: r.point,
        ciLow: r.ciLow,
        ciHigh: r.ciHigh,
        iterations: r.iterations,
        n: r.n,
      };
    }
    out.push({
      key,
      identity: bucket.identity,
      metrics,
      contributingRuns: bucket.contributingRuns,
    });
  }

  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/**
 * Render one `AggregatorRow` as a row in a CSV in the format
 * `identity, metric1_mean, metric1_ci_low, metric1_ci_high, ...`.
 * Use with `harness/reports.writeCsv` after computing the header row
 * via `buildAggregatedHeader`.
 */
export function flattenAggregatedRow(
  row: AggregatorRow,
  identityKeys: ReadonlyArray<string>,
  numericKeys: ReadonlyArray<string>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const k of identityKeys) out[k] = row.identity[k] ?? "";
  out.contributingRuns = row.contributingRuns;
  for (const k of numericKeys) {
    const m = row.metrics[k]!;
    out[`${k}_mean`] = round(m.mean);
    out[`${k}_ci_low`] = round(m.ciLow);
    out[`${k}_ci_high`] = round(m.ciHigh);
    out[`${k}_n`] = m.n;
  }
  return out;
}

export function buildAggregatedHeader(
  identityKeys: ReadonlyArray<string>,
  numericKeys: ReadonlyArray<string>,
): string[] {
  const out: string[] = [...identityKeys, "contributingRuns"];
  for (const k of numericKeys) {
    out.push(`${k}_mean`, `${k}_ci_low`, `${k}_ci_high`, `${k}_n`);
  }
  return out;
}

function round(x: number): number {
  if (!Number.isFinite(x)) return x;
  return Math.round(x * 1e4) / 1e4;
}
