/**
 * Generic seed-deterministic stratified sampler.
 *
 * Given a flat array and a `keyFn` that buckets each item into a
 * stratum, return a subset where each stratum keeps the same
 * proportion as the full population (`fraction` × stratum size,
 * rounded). Sampling within a stratum uses a Fisher-Yates shuffle
 * driven by the supplied RNG — pass `seededRng(seed)` for a
 * deterministic, reproducible subset.
 *
 * Two safeties:
 *
 *   - `opts.minPerStratum` raises the floor for small strata (e.g.
 *     `temporal` has only 96 LoCoMo questions out of 1986 — at
 *     `fraction=0.25` we'd take 24, fine; at `fraction=0.05` we'd
 *     take 5, which is too few for any meaningful per-category claim,
 *     so the operator can raise the floor to 10).
 *   - The output **preserves the original input order**, not the
 *     shuffled order. This way two runs on the same subset feed
 *     prompts in the same sequence the original corpus would have —
 *     deletion is the only delta, not reordering. Tests pin this.
 *
 * Returns a fresh array; never mutates `items`.
 */
export function stratifiedSample<T>(
  items: readonly T[],
  keyFn: (item: T) => string,
  fraction: number,
  rng: () => number,
  opts?: { minPerStratum?: number },
): T[] {
  if (items.length === 0) return [];
  if (fraction <= 0 && (opts?.minPerStratum ?? 0) <= 0) return [];
  if (fraction >= 1) return [...items];
  const minPer = Math.max(0, opts?.minPerStratum ?? 0);

  const buckets = new Map<string, number[]>(); // stratum → original indexes
  for (let i = 0; i < items.length; i += 1) {
    const k = keyFn(items[i]!);
    const arr = buckets.get(k) ?? [];
    arr.push(i);
    buckets.set(k, arr);
  }

  const kept = new Set<number>();
  // Sort bucket keys for deterministic iteration order, otherwise the
  // RNG would be consumed in Map insertion order (still deterministic,
  // but harder to reason about across machines / runtimes).
  const orderedKeys = [...buckets.keys()].sort();
  for (const key of orderedKeys) {
    const indexes = buckets.get(key)!;
    const take = Math.min(
      indexes.length,
      Math.max(minPer, Math.round(indexes.length * fraction)),
    );
    if (take === 0) continue;
    const shuffled = shuffleInPlace([...indexes], rng);
    for (let i = 0; i < take; i += 1) kept.add(shuffled[i]!);
  }

  // Preserve original input order.
  return items.filter((_v, i) => kept.has(i));
}

function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/**
 * Convenience summary of a stratified subset — surfaces per-stratum
 * before / after counts so a `summary.md` or meta JSON can show the
 * sampling proportions without recomputing.
 */
export interface StratumBreakdown {
  key: string;
  before: number;
  after: number;
  fraction: number;
}

export function summariseStrata<T>(
  before: readonly T[],
  after: readonly T[],
  keyFn: (item: T) => string,
): StratumBreakdown[] {
  const beforeCounts = new Map<string, number>();
  const afterCounts = new Map<string, number>();
  for (const it of before) {
    const k = keyFn(it);
    beforeCounts.set(k, (beforeCounts.get(k) ?? 0) + 1);
  }
  for (const it of after) {
    const k = keyFn(it);
    afterCounts.set(k, (afterCounts.get(k) ?? 0) + 1);
  }
  const keys = new Set([...beforeCounts.keys(), ...afterCounts.keys()]);
  const out: StratumBreakdown[] = [];
  for (const key of [...keys].sort()) {
    const b = beforeCounts.get(key) ?? 0;
    const a = afterCounts.get(key) ?? 0;
    out.push({
      key,
      before: b,
      after: a,
      fraction: b > 0 ? a / b : 0,
    });
  }
  return out;
}
