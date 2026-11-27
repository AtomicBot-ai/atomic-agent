import { numbersIn, type NumberToken } from "./evidence-check.js";
import type { Contradiction, VerifiedFinding } from "./research-types.js";

/** Values closer than this (relative) are the same figure, rounded differently. */
const TOLERANCE = 0.05;
export const MAX_CONTRADICTIONS = 10;

/** 1900..2099 standing alone: a year, the context of a figure, not the figure. */
function isYear(n: NumberToken): boolean {
  return Number.isInteger(n.value) && n.value >= 1900 && n.value <= 2099 && !n.percent && !n.text.includes(",");
}

/** A word after a number that says nothing about what was counted. */
const NOT_A_UNIT = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "per", "the", "to", "with"]);

/** The claim's figures with a unit, keyed by unit; years are kept apart as context. */
function figuresOf(claim: string): { figures: NumberToken[]; years: string } {
  const all = numbersIn(claim);
  const years = all.filter(isYear).map((n) => n.value).sort().join(",");
  const figures = all.filter((n) => !isYear(n) && n.unit.length > 0 && !NOT_A_UNIT.has(n.unit));
  return { figures, years };
}

function differ(a: NumberToken, b: NumberToken): boolean {
  const x = a.scaled;
  const y = b.scaled;
  const size = Math.max(Math.abs(x), Math.abs(y));
  return size > 0 && Math.abs(x - y) / size > TOLERANCE;
}

/** "million" and "billion" are both money-sized amounts: compare them scaled. */
function unitKey(n: NumberToken): string {
  return n.scaled !== n.value ? "amount" : n.unit;
}

/**
 * Deterministic conflicting-numbers pass (ATO-2133): two verified
 * findings on the same sub-question, from different pages, that state a
 * figure with the same unit and the same years (or none) but values more
 * than 5% apart. It flags; it does not decide which source is right, and
 * it can flag two figures that measure different things.
 */
export function findContradictions(findings: readonly VerifiedFinding[]): Contradiction[] {
  const out: Contradiction[] = [];
  const read = findings.map((finding) => ({ finding, ...figuresOf(finding.claim) }));
  for (let i = 0; i < read.length; i++) {
    for (let j = i + 1; j < read.length; j++) {
      const a = read[i]!;
      const b = read[j]!;
      if (a.finding.subQuestion !== b.finding.subQuestion) continue;
      if (a.finding.url === b.finding.url) continue;
      if (a.years !== b.years) continue;
      const pair = firstConflict(a.figures, b.figures);
      if (pair === null) continue;
      out.push({
        subQuestion: a.finding.subQuestion,
        unit: pair.unit,
        a: a.finding,
        b: b.finding,
        values: [pair.x, pair.y],
      });
      if (out.length >= MAX_CONTRADICTIONS) return out;
    }
  }
  return out;
}

function firstConflict(
  left: readonly NumberToken[],
  right: readonly NumberToken[],
): { unit: string; x: string; y: string } | null {
  for (const x of left) {
    const sameUnit = right.filter((y) => unitKey(y) === unitKey(x));
    // The same figure on both sides means they agree on this unit.
    if (sameUnit.length === 0 || sameUnit.some((y) => !differ(x, y))) continue;
    const y = sameUnit[0]!;
    const show = (n: NumberToken): string => (n.percent ? `${n.text}%` : `${n.text} ${n.unit}`);
    return { unit: x.unit, x: show(x), y: show(y) };
  }
  return null;
}
