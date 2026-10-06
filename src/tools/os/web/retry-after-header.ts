/**
 * `Retry-After` normalisation, shared by `os.web.fetch` and `os.http.request`.
 *
 * Both tools retry transient failures and both honour a server-sent
 * `Retry-After`, but they read it off curl differently (`%{header_json}` vs
 * `%header{retry-after}`). The RFC 9110 value grammar is the same either way,
 * so it is defined once here rather than drifting between two copies.
 */

/**
 * Parse a raw `Retry-After` value to milliseconds. Handles both documented
 * forms — delta-seconds (`120`) and an HTTP-date — and returns `null` for
 * anything unparseable, so callers fall back to their own backoff schedule.
 *
 * A date already in the past clamps to `0`: retry immediately rather than
 * not at all.
 */
export function parseRetryAfterValueMs(
  value: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return null;

  // Anchored so a partially-numeric value like "10abc" is rejected rather
  // than silently read as 10 seconds.
  if (/^\d+$/.test(text)) {
    const seconds = Number.parseInt(text, 10);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }

  const dateMs = Date.parse(text);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - now);
}
