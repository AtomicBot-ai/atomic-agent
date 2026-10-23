/**
 * Whether a cut-off reply ended in a loop: the same block of text
 * repeated back to back until the cap ran out.
 *
 * A small local model that degenerates (the same code line, or `}]"}]`
 * over and over) spends any cap it is given, so raising the cap on the
 * retry only buys a longer loop. Seen live: 16,384 tokens of repeated
 * code in 18 minutes on an 8 GB Mac. The truncation retry reads this to
 * keep the cap where it was.
 *
 * Only the tail is checked, for an exact period: the last
 * `max(period × MIN_REPEATS, MIN_SPAN_CHARS)` characters must be one
 * block repeated. Real file content (rows of a table, similar functions)
 * differs from block to block, so it does not match.
 */

/** Longest block, in characters, that counts as a repeating unit. */
export const MAX_REPEAT_PERIOD_CHARS = 512;

/** A block must repeat at least this many times in a row. */
const MIN_REPEATS = 4;

/** And the repeated run must cover at least this much text. */
export const MIN_SPAN_CHARS = 256;

export function hasRepetitiveTail(text: string): boolean {
  return repetitiveTailPeriod(text, MIN_REPEATS) !== null;
}

/**
 * The shortest period, in characters, the tail of `text` repeats with,
 * or `null` when it does not loop: the last
 * `max(period × minRepeats, MIN_SPAN_CHARS)` characters (trailing
 * whitespace aside) must be one block repeated exactly.
 */
export function repetitiveTailPeriod(
  text: string,
  minRepeats: number,
): number | null {
  const tail = text.trimEnd();
  const n = tail.length;
  if (n < MIN_SPAN_CHARS) return null;
  for (let period = 1; period <= MAX_REPEAT_PERIOD_CHARS; period += 1) {
    const span = Math.max(period * minRepeats, MIN_SPAN_CHARS);
    if (span > n) break;
    let periodic = true;
    for (let k = n - span + period; k < n; k += 1) {
      if (tail.charCodeAt(k) !== tail.charCodeAt(k - period)) {
        periodic = false;
        break;
      }
    }
    if (periodic) return period;
  }
  return null;
}
