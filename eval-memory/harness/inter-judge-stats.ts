/**
 * Inter-rater agreement helpers for the judge-vs-judge cross-check.
 *
 * Two judges rate the same N items on the same K-level ordinal scale
 * (1..K, K=5 for LoCoMo today). We want to know:
 *
 *  - `exactAgreement` — fraction of items where both scores match
 *    exactly. Low (< 0.5) is normal for 5-level ordinal scales even
 *    among humans; report alongside κ for honesty.
 *  - `withinOneAgreement` — fraction where the two scores differ by
 *    at most 1. Closer to a "soft pass" check.
 *  - `cohenKappa(unweighted)` — chance-corrected exact agreement.
 *    κ ≥ 0.6 = "substantial"; ≥ 0.8 = "almost perfect" (Landis-Koch).
 *  - `cohenKappa(quadratic)` — quadratic-weighted κ. The Kaggle-AES
 *    convention for ordinal grading; penalises far-off disagreement
 *    harder than near-off. Always ≥ unweighted κ on ordinal data.
 *
 * All helpers operate on integer scores in `[1, levels]`; scores
 * outside the range throw because silent clipping would distort the
 * confusion matrix. Empty input returns degenerate values
 * (`exactAgreement=0`, `kappa=0`) — callers should always check the
 * sample size before publishing the result.
 */

export type KappaWeighting = "unweighted" | "linear" | "quadratic";

/** Number of items where `a[i] === b[i]`, divided by the total. */
export function exactAgreement(
  a: readonly number[],
  b: readonly number[],
): number {
  assertSameLength(a, b);
  if (a.length === 0) return 0;
  let hits = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] === b[i]) hits += 1;
  return hits / a.length;
}

/** Fraction of items where `|a[i] - b[i]| <= 1`. */
export function withinOneAgreement(
  a: readonly number[],
  b: readonly number[],
): number {
  assertSameLength(a, b);
  if (a.length === 0) return 0;
  let hits = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs(a[i] - b[i]) <= 1) hits += 1;
  }
  return hits / a.length;
}

/**
 * Build the K×K confusion matrix `C[i][j]` = count of items where
 * rater A scored `i+1` and rater B scored `j+1`. Rows are A's
 * marginals, columns are B's.
 */
export function confusionMatrix(
  a: readonly number[],
  b: readonly number[],
  levels: number,
): number[][] {
  assertSameLength(a, b);
  assertLevels(levels);
  const mat: number[][] = Array.from({ length: levels }, () =>
    new Array<number>(levels).fill(0),
  );
  for (let i = 0; i < a.length; i += 1) {
    assertInRange(a[i], levels, "a");
    assertInRange(b[i], levels, "b");
    mat[a[i] - 1][b[i] - 1] += 1;
  }
  return mat;
}

/**
 * Cohen's kappa (unweighted | linear | quadratic). Empty input or
 * `pe === 1` (everyone agrees by chance on the same level) ⇒ returns
 * `0` — the metric is undefined, and `0` is the conventional
 * "no-information" fallback.
 */
export function cohenKappa(
  a: readonly number[],
  b: readonly number[],
  levels: number,
  weighting: KappaWeighting = "unweighted",
): number {
  assertSameLength(a, b);
  if (a.length === 0) return 0;
  const C = confusionMatrix(a, b, levels);
  const n = a.length;
  const rowSums = C.map((row) => row.reduce((s, v) => s + v, 0));
  const colSums = new Array<number>(levels).fill(0);
  for (let i = 0; i < levels; i += 1) {
    for (let j = 0; j < levels; j += 1) colSums[j] += C[i][j];
  }
  const w = buildWeightMatrix(levels, weighting);
  let observed = 0;
  let expected = 0;
  for (let i = 0; i < levels; i += 1) {
    for (let j = 0; j < levels; j += 1) {
      const oij = C[i][j] / n;
      const eij = (rowSums[i] * colSums[j]) / (n * n);
      observed += w[i][j] * oij;
      expected += w[i][j] * eij;
    }
  }
  if (expected === 1) return 0;
  return (observed - expected) / (1 - expected);
}

function buildWeightMatrix(
  levels: number,
  weighting: KappaWeighting,
): number[][] {
  const mat: number[][] = Array.from({ length: levels }, () =>
    new Array<number>(levels).fill(0),
  );
  for (let i = 0; i < levels; i += 1) {
    for (let j = 0; j < levels; j += 1) {
      if (weighting === "unweighted") {
        mat[i][j] = i === j ? 1 : 0;
      } else if (weighting === "linear") {
        mat[i][j] = 1 - Math.abs(i - j) / (levels - 1);
      } else {
        const d = (i - j) / (levels - 1);
        mat[i][j] = 1 - d * d;
      }
    }
  }
  return mat;
}

function assertSameLength(a: readonly number[], b: readonly number[]): void {
  if (a.length !== b.length) {
    throw new Error(
      `inter-judge-stats: rater arrays differ in length (${a.length} vs ${b.length})`,
    );
  }
}

function assertLevels(levels: number): void {
  if (!Number.isInteger(levels) || levels < 2) {
    throw new Error(`inter-judge-stats: levels must be integer >= 2 (got ${levels})`);
  }
}

function assertInRange(score: number, levels: number, label: string): void {
  if (!Number.isInteger(score) || score < 1 || score > levels) {
    throw new Error(
      `inter-judge-stats: ${label} score ${score} outside [1, ${levels}]`,
    );
  }
}

/**
 * Aggregate triple commonly reported in inter-judge summaries.
 * `levels` is the score scale (5 for LoCoMo).
 */
export interface InterJudgeReport {
  n: number;
  exactAgreement: number;
  withinOneAgreement: number;
  cohenKappaUnweighted: number;
  cohenKappaQuadratic: number;
}

export function buildInterJudgeReport(
  a: readonly number[],
  b: readonly number[],
  levels: number,
): InterJudgeReport {
  return {
    n: a.length,
    exactAgreement: exactAgreement(a, b),
    withinOneAgreement: withinOneAgreement(a, b),
    cohenKappaUnweighted: cohenKappa(a, b, levels, "unweighted"),
    cohenKappaQuadratic: cohenKappa(a, b, levels, "quadratic"),
  };
}
