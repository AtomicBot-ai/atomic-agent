/**
 * A 400 that names the one temperature a model accepts.
 *
 * Moonshot answers a Kimi K3.1 request with any temperature but 1 with
 * "invalid temperature: only 1 is allowed for this model". The static
 * rule in `model-params.ts` covers the ids we know; this reads the same
 * lesson off the wire for an id we do not, so the chat path can resend
 * once with the named value and keep it for the rest of the process
 * (`rememberAllowedTemperature`).
 *
 * Deliberately narrow: only a 400, only the "only N is allowed" phrasing,
 * and only when "temperature" is said close to it. Any other 400 is left
 * alone and fails the way it always did.
 */

const ONLY_ALLOWED_RE = /only\s+([0-9]+(?:\.[0-9]+)?)\s+is\s+allowed/i;

/** How far from the "only N is allowed" phrase "temperature" may be. */
const NEAR_CHARS = 160;

export function parseAllowedTemperature(text: string): number | undefined {
  const match = ONLY_ALLOWED_RE.exec(text);
  if (!match) return undefined;
  const from = Math.max(0, match.index - NEAR_CHARS);
  const to = match.index + match[0].length + NEAR_CHARS;
  if (!/temperature/i.test(text.slice(from, to))) return undefined;
  const value = Number(match[1]);
  // OpenAI-compatible temperatures live in [0, 2]; anything else is a
  // misread, not a lesson.
  if (!Number.isFinite(value) || value < 0 || value > 2) return undefined;
  return value;
}

/** The allowed temperature an HTTP error names, if it is that 400. */
export function allowedTemperatureFromError(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  if ((err as { status?: unknown }).status !== 400) return undefined;
  return parseAllowedTemperature(err.message);
}
