/**
 * Parsers for the per-task budget flags (ATO-1108): `--max-cost-usd`
 * and `--max-duration` on `task create`. Each returns `null` for a value
 * it cannot read, so the caller can print one usage line.
 */

const DURATION_UNITS_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * A dollar amount: `5`, `2.50`, `$5`. Must be positive and finite; `0`
 * is refused because on a task it would read as "no cap".
 */
export function parseUsdFlag(raw: string): number | null {
  const text = raw.trim().replace(/^\$/, "");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * A duration: `90s`, `30m`, `8h`, `1h30m`, `2d`, `500ms`; a bare number
 * is seconds, like `task create --every`. Returns whole milliseconds,
 * positive, or `null`.
 */
export function parseDurationFlag(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (text.length === 0) return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const ms = Math.round(Number(text) * 1_000);
    return ms > 0 ? ms : null;
  }
  const part = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gy;
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(part)) {
    total += Number(match[1]) * DURATION_UNITS_MS[match[2]!]!;
    consumed += match[0].length;
  }
  if (consumed !== text.length) return null;
  const ms = Math.round(total);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}
