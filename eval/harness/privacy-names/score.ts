/**
 * Scoring for the Privacy Shield names benchmark (ATO-2527). Pure: no
 * model, no network. The runner (`eval/scripts/run-privacy-names.ts`)
 * feeds it what the local pass found for each letter and the text as it
 * would have gone to the cloud.
 *
 * Two questions, kept apart:
 *
 *  - Recall (what leaks): an expected span is covered when the masked
 *    text no longer contains it. This is what matters for privacy, and it
 *    counts a span the model labelled with the wrong kind as covered.
 *  - Precision (what gets shredded): a found value is correct when it
 *    overlaps an expected span (one contains the other: "Mrs. Abernathy"
 *    for "Abernathy", or "Иван" as the part of "Иван Петров"). Anything
 *    else is an ordinary word masked for nothing.
 */

export type FixtureKind = "NAME" | "ADDRESS" | "ORG";

export interface FixtureLetter {
  id: string;
  text: string;
  spans: { text: string; kind: FixtureKind }[];
}

export interface LetterScore {
  id: string;
  expected: number;
  covered: number;
  /** Expected spans still readable in the masked text. */
  leaked: string[];
  found: number;
  correct: number;
  /** Found values that match no expected span. */
  falsePositives: string[];
  latencyMs: number;
  /** The pass failed or timed out for this letter (regex only). */
  failed: boolean;
}

export interface BenchSummary {
  letters: number;
  expected: number;
  covered: number;
  recall: number;
  found: number;
  correct: number;
  precision: number;
  failedLetters: number;
  latencyMs: { p50: number; p95: number; max: number };
}

export function scoreLetter(
  letter: FixtureLetter,
  found: readonly { value: string }[],
  masked: string,
  latencyMs: number,
  failed = false,
): LetterScore {
  const leaked = letter.spans.filter((s) => masked.includes(s.text)).map((s) => s.text);
  const falsePositives = found
    .map((f) => f.value)
    .filter((v) => !letter.spans.some((s) => s.text.includes(v) || v.includes(s.text)));
  return {
    id: letter.id,
    expected: letter.spans.length,
    covered: letter.spans.length - leaked.length,
    leaked,
    found: found.length,
    correct: found.length - falsePositives.length,
    falsePositives,
    latencyMs,
    failed,
  };
}

/** The `p`-th percentile (0 to 100) by nearest rank; 0 for no values. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

const ratio = (part: number, whole: number): number => (whole === 0 ? 1 : part / whole);

export function summarize(scores: readonly LetterScore[]): BenchSummary {
  const sum = (pick: (s: LetterScore) => number): number => scores.reduce((n, s) => n + pick(s), 0);
  const expected = sum((s) => s.expected);
  const covered = sum((s) => s.covered);
  const found = sum((s) => s.found);
  const correct = sum((s) => s.correct);
  const latencies = scores.map((s) => s.latencyMs);
  return {
    letters: scores.length,
    expected,
    covered,
    recall: ratio(covered, expected),
    found,
    correct,
    precision: ratio(correct, found),
    failedLetters: scores.filter((s) => s.failed).length,
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length === 0 ? 0 : Math.max(...latencies),
    },
  };
}

/** Every span is in its letter word for word, ids are unique, kinds are known. */
export function checkFixtures(letters: readonly FixtureLetter[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const letter of letters) {
    if (ids.has(letter.id)) problems.push(`${letter.id}: duplicate id`);
    ids.add(letter.id);
    for (const span of letter.spans) {
      if (!letter.text.includes(span.text)) problems.push(`${letter.id}: "${span.text}" is not in the text`);
      if (!["NAME", "ADDRESS", "ORG"].includes(span.kind)) problems.push(`${letter.id}: unknown kind ${span.kind}`);
    }
  }
  return problems;
}
