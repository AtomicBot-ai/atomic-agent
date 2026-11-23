/**
 * Finds personal data and secrets in text that is about to leave the
 * machine (Privacy Shield, ATO-599). Regex first, on purpose: it runs on
 * every cloud request, so it has to be cheap, linear and predictable. A
 * local-model pass for names and addresses is a later step.
 *
 * Kinds, in the order they win an overlap:
 *
 *  - `SECRET`: everything the shared credential detector masks
 *    (`src/error-reporting/secret-detector.ts`: vendor key shapes, PEM
 *    keys, bearer / basic credentials, URL passwords, secret-named
 *    pairs, and the agent's own known keys). Its markers are aligned
 *    back to the original text, so the detector stays the one place that
 *    knows what a key looks like.
 *  - `IBAN`: two letters, two check digits and up to 30 letters or
 *    digits, optionally grouped by four, that pass the mod-97 check.
 *  - `CARD`: 13 to 19 digits, optionally grouped by spaces or dashes,
 *    starting 2 to 6, that pass the Luhn check, and not the digit groups
 *    of an IBAN (`DE89 3704 …`).
 *  - `EMAIL`: `local@domain.tld`.
 *  - `PHONE`: an international number (`+` and 8 to 15 digits), or a
 *    national one written with its area code in brackets
 *    (`(555) 123-4567`, `8 (912) 345-67-89`). A bare run of digits is
 *    not taken for a phone: it is far more often an id, a time or a size.
 *
 * Every pattern is linear: literal anchors, bounded quantifiers, no
 * nested ambiguous repetition. Each rule is skipped when its literal
 * (`@`, `+`, `(`, a digit) cannot occur in the text.
 */

import { maskSecrets, type KnownSecret } from "../error-reporting/secret-detector.js";

export type PrivateKind = "SECRET" | "IBAN" | "CARD" | "EMAIL" | "PHONE";

/** Overlap priority: an earlier kind wins a span a later one also matched. */
export const PRIVATE_KINDS: readonly PrivateKind[] = ["SECRET", "IBAN", "CARD", "EMAIL", "PHONE"];

export interface PrivateSpan {
  /** Offset of the first character in the scanned text. */
  start: number;
  /** Offset one past the last character. */
  end: number;
  kind: PrivateKind;
  /** `text.slice(start, end)`. */
  value: string;
}

const MARKER = /\[redacted:[A-Za-z0-9_.-]{1,64}\]/g;

/**
 * The spans `maskSecrets` would replace. It only ever swaps a substring
 * for a `[redacted:<hint>]` marker, so the text between markers is
 * copied verbatim and in order; each secret is what lies between the
 * literal piece before its marker and the piece after it. Markers with
 * nothing between them (two secrets back to back) become one span.
 */
export function findSecretSpans(text: string, known: readonly KnownSecret[] = []): PrivateSpan[] {
  const masked = maskSecrets(text, known);
  if (masked === text) return [];
  const pieces: string[] = [];
  let last = 0;
  MARKER.lastIndex = 0;
  for (let m = MARKER.exec(masked); m !== null; m = MARKER.exec(masked)) {
    pieces.push(masked.slice(last, m.index));
    last = m.index + m[0].length;
  }
  pieces.push(masked.slice(last));
  const head = pieces[0] ?? "";
  if (!text.startsWith(head)) return [];
  const spans: PrivateSpan[] = [];
  let pos = head.length;
  for (let i = 1; i < pieces.length; i += 1) {
    const after = pieces[i]!;
    // Back-to-back markers: the next literal piece closes them all.
    if (after.length === 0 && i < pieces.length - 1) continue;
    let end: number;
    if (i === pieces.length - 1) {
      if (!text.endsWith(after)) break;
      end = text.length - after.length;
    } else {
      end = text.indexOf(after, pos + 1);
    }
    if (end <= pos) break;
    const value = text.slice(pos, end);
    // A marker already present in the input is not a secret of its own.
    if (!/^\[redacted:[A-Za-z0-9_.-]{1,64}\]$/.test(value)) {
      spans.push({ start: pos, end, kind: "SECRET", value });
    }
    pos = end + after.length;
  }
  return spans;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function ibanValid(compact: string): boolean {
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const chunk = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const digit of chunk) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

const CARD = /(?<![A-Za-z0-9_.+-])(?<![A-Z]{2}\d{2} )[2-6]\d{3}(?:[ -]?\d){9,15}(?![A-Za-z0-9_])/g;
const IBAN = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![A-Za-z0-9])/g;
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9][A-Za-z0-9-]{0,62}(?:\.[A-Za-z0-9][A-Za-z0-9-]{0,62}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;
const PHONE_INTERNATIONAL = /(?<![A-Za-z0-9_+])\+\d[\d ().-]{6,22}\d(?![A-Za-z0-9_])/g;
const PHONE_BRACKETED =
  /(?<![A-Za-z0-9_])(?:[78] ?)?\(\d{3}\) ?\d{3}[ .-]?\d{2}[ .-]?\d{2}(?![A-Za-z0-9_])/g;

function collect(
  text: string,
  re: RegExp,
  kind: PrivateKind,
  accept: (match: string) => boolean,
  out: PrivateSpan[],
): void {
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (accept(m[0])) out.push({ start: m.index, end: m.index + m[0].length, kind, value: m[0] });
  }
}

const digitCount = (s: string): number => s.replace(/\D/g, "").length;

function acceptCard(match: string): boolean {
  // One grouping style per number: `4111 1111 1111 1111` or
  // `4111-1111-…`, not a mix that is more likely two numbers side by side.
  if (match.includes(" ") && match.includes("-")) return false;
  const digits = match.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  return luhnValid(digits);
}

/**
 * Card candidates. The CARD pattern is greedy, so a number pasted with its
 * expiry or CVV right after it (`4242 4242 4242 4242 12/25`, `…4242 123`)
 * matches as one longer run that fails Luhn. When the whole run fails, try
 * the shorter prefixes that end at a group boundary (a space or dash), longest
 * first, and keep the first one that is a valid card. The scan then resumes
 * right after what was kept.
 */
function collectCards(text: string, out: PrivateSpan[]): void {
  CARD.lastIndex = 0;
  for (let m = CARD.exec(text); m !== null; m = CARD.exec(text)) {
    const match = m[0];
    const ends = [match.length];
    for (let i = match.length - 1; i > 0; i--) {
      if ((match[i] === " " || match[i] === "-") && /\d/.test(match[i - 1] ?? "")) ends.push(i);
    }
    const end = ends.find((e) => acceptCard(match.slice(0, e)));
    if (end === undefined) continue;
    out.push({ start: m.index, end: m.index + end, kind: "CARD", value: match.slice(0, end) });
    CARD.lastIndex = m.index + end;
  }
}

function acceptPhone(match: string): boolean {
  const n = digitCount(match);
  if (n < 8 || n > 15) return false;
  // Brackets must pair up, or this is a formula, not a number.
  return (match.match(/\(/g) ?? []).length === (match.match(/\)/g) ?? []).length;
}

/**
 * Every private span in `text`, sorted by position, never overlapping.
 * `known` adds exact values the agent knows are secret (its own keys).
 */
export function findPrivateSpans(text: string, known: readonly KnownSecret[] = []): PrivateSpan[] {
  if (text.length < 6) return [];
  const candidates: PrivateSpan[] = [...findSecretSpans(text, known)];
  const hasDigit = /\d/.test(text);
  if (hasDigit && /[A-Z]{2}\d{2}/.test(text)) {
    collect(text, IBAN, "IBAN", (m) => ibanValid(m.replace(/ /g, "")), candidates);
  }
  if (hasDigit) collectCards(text, candidates);
  if (text.includes("@")) collect(text, EMAIL, "EMAIL", () => true, candidates);
  if (hasDigit && text.includes("+")) collect(text, PHONE_INTERNATIONAL, "PHONE", acceptPhone, candidates);
  if (hasDigit && text.includes("(")) collect(text, PHONE_BRACKETED, "PHONE", acceptPhone, candidates);
  if (candidates.length === 0) return [];
  // Candidates are already in priority order (kinds were collected in
  // PRIVATE_KINDS order); keep each one that does not overlap a kept one.
  const kept: PrivateSpan[] = [];
  for (const span of candidates) {
    if (kept.some((k) => span.start < k.end && k.start < span.end)) continue;
    kept.push(span);
  }
  return kept.sort((a, b) => a.start - b.start);
}
