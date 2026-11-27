/**
 * Mechanical evidence checks for `research.deep` (ATO-2133). Pure: no
 * model, no network. A finding is a claim, the quote that supports it
 * and the page it came from; these checks decide whether the quote is
 * really on that page and whether the claim's numbers come from the
 * quote. Nothing here can turn a finding true, only keep it out of the
 * verified list.
 */

/** Shorter quotes match too easily by chance ("the", "in 2024"). */
export const MIN_QUOTE_CHARS = 20;
/** Each piece of a quote cut with "..." must be at least this long. */
const MIN_QUOTE_PIECE_CHARS = 8;
/** Pair search over quote numbers stays small. */
const MAX_QUOTE_NUMBERS = 12;

/**
 * Text as compared: Unicode compatibility form, typographic quotes and
 * dashes as ASCII, no-break spaces as spaces, whitespace collapsed,
 * lower case. Applied to both the page and the quote.
 */
export function normalizeForQuote(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The quote's own wrapping quote marks and outer ellipses removed. */
function trimQuote(normalized: string): string {
  return normalized.replace(/^(?:["']|\.\.\.|\s)+/, "").replace(/(?:["']|\.\.\.|\s)+$/, "");
}

export type QuoteCheck =
  | { found: true }
  | { found: false; reason: "too_short" | "not_on_page" };

/**
 * Does `quote` appear verbatim in `pageText` (after normalization)? A
 * quote that skips text with "..." matches when every piece appears, in
 * order. A fabricated or paraphrased quote does not.
 */
export function quoteAppearsIn(quote: string, pageText: string): QuoteCheck {
  const q = trimQuote(normalizeForQuote(quote));
  if (q.length < MIN_QUOTE_CHARS) return { found: false, reason: "too_short" };
  const page = normalizeForQuote(pageText);
  const pieces = q.split("...").map((piece) => piece.trim()).filter((piece) => piece.length > 0);
  if (pieces.some((piece) => piece.length < MIN_QUOTE_PIECE_CHARS)) {
    return { found: false, reason: "too_short" };
  }
  let from = 0;
  for (const piece of pieces) {
    const at = page.indexOf(piece, from);
    if (at === -1) return { found: false, reason: "not_on_page" };
    from = at + piece.length;
  }
  return { found: true };
}

/** One number as written, with its value and, after a scale word, the scaled value. */
export interface NumberToken {
  text: string;
  value: number;
  /** "1.2 million" -> 1_200_000; equal to `value` without a scale word. */
  scaled: number;
  percent: boolean;
  /** The word right after the number, lower case ("users", "million"), or "%". */
  unit: string;
}

const SCALES: Record<string, number> = {
  thousand: 1e3,
  k: 1e3,
  million: 1e6,
  mn: 1e6,
  billion: 1e9,
  bn: 1e9,
  b: 1e9,
  trillion: 1e12,
  tn: 1e12,
};

const NUMBER = /(?<![\w.])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d])|(?<![\w.])-?\d+(?:\.\d+)?(?![\d])/g;

/** Every number in `text`, in order. Thousands separators are read ("1,200" is 1200). */
export function numbersIn(text: string): NumberToken[] {
  const source = text.normalize("NFKC").replace(/\u2212/g, "-");
  const out: NumberToken[] = [];
  for (const match of source.matchAll(NUMBER)) {
    const raw = match[0];
    const value = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const after = source.slice((match.index ?? 0) + raw.length);
    const percent = /^\s?(?:%|percent\b|per cent\b)/i.test(after);
    const word = /^\s?([a-z]+)/i.exec(after)?.[1]?.toLowerCase() ?? "";
    const scale = SCALES[word] ?? 1;
    out.push({ text: raw, value, scaled: value * scale, percent, unit: percent ? "%" : word });
  }
  return out;
}

function same(a: number, b: number): boolean {
  if (a === b) return true;
  const size = Math.max(Math.abs(a), Math.abs(b));
  return size > 0 && Math.abs(a - b) / size < 1e-9;
}

/** `value` rounded the way a claim states it: to as many decimals as `text` has. */
function roundsTo(value: number, text: string): boolean {
  const decimals = /\.(\d+)$/.exec(text)?.[1]?.length ?? 0;
  const target = Number(text.replace(/,/g, ""));
  return Number.isFinite(value) && same(Number(value.toFixed(decimals)), target);
}

/**
 * A claim number not written in the quote but computed from two of its
 * numbers: a sum, a difference, or a share as a percentage. Returns how,
 * or null. Kept to pairs: anything longer is a guess, not a check.
 */
export function derivedFrom(claim: NumberToken, quoteNumbers: readonly NumberToken[]): string | null {
  const nums = quoteNumbers.slice(0, MAX_QUOTE_NUMBERS);
  for (let i = 0; i < nums.length; i++) {
    for (let j = 0; j < nums.length; j++) {
      if (i === j) continue;
      const a = nums[i]!;
      const b = nums[j]!;
      if (i < j && !claim.percent && same(a.value + b.value, claim.value)) return `${claim.text} = ${a.text} + ${b.text}`;
      if (!claim.percent && a.value > b.value && same(a.value - b.value, claim.value)) return `${claim.text} = ${a.text} - ${b.text}`;
      if (claim.percent && b.value !== 0 && roundsTo((a.value / b.value) * 100, claim.text)) {
        return `${claim.text}% = ${a.text} / ${b.text} x 100`;
      }
      if (claim.percent && a.value !== 0 && roundsTo(((b.value - a.value) / a.value) * 100, claim.text)) {
        return `${claim.text}% = (${b.text} - ${a.text}) / ${a.text} x 100`;
      }
    }
  }
  return null;
}

export interface NumberCheck {
  /** Every claim number is in the quote or computed from it. */
  ok: boolean;
  /** Claim numbers neither in the quote nor computed from it, as written. */
  unsupported: string[];
  /** How each computed number was recomputed. */
  derived: string[];
}

/**
 * The claim's numbers against the quote's: each must be in the quote
 * (same value, or same value after a scale word: "1.2 million" and
 * "1,200,000"), or follow from two quote numbers by {@link derivedFrom}.
 */
export function checkNumbers(claim: string, quote: string): NumberCheck {
  const quoteNumbers = numbersIn(quote);
  const unsupported: string[] = [];
  const derived: string[] = [];
  for (const n of numbersIn(claim)) {
    const direct = quoteNumbers.some((q) => same(q.value, n.value) || same(q.scaled, n.scaled));
    if (direct) continue;
    const how = derivedFrom(n, quoteNumbers);
    if (how !== null) derived.push(how);
    else unsupported.push(n.percent ? `${n.text}%` : n.text);
  }
  return { ok: unsupported.length === 0, unsupported, derived };
}
