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
 *
 * The same file reads the other temperature lesson a 400 can carry: that
 * the model takes no temperature at all (`parseTemperatureRefused`).
 * Anthropic's newer Claude models answer the field as deprecated; the
 * static rule covers the ids we know, this covers the next one.
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

/**
 * Words a 400 uses to refuse a field outright, as opposed to refusing its
 * value: Anthropic's newer Claude models call `temperature` deprecated
 * (ATO-1397), OpenAI's reasoning models call it an unsupported parameter,
 * strict validators call it unknown or not permitted.
 */
const FIELD_REFUSED_RE =
  /\b(?:deprecated|no longer supported|not supported|unsupported|not allowed|not permitted|unknown (?:parameter|field)|unrecognized|removed)\b/gi;

/**
 * How far from the refusal word "temperature" may be. Tighter than for
 * the named value: validators that echo the request body back would
 * otherwise put "temperature" near a refusal of some other field.
 */
const REFUSAL_NEAR_CHARS = 80;

/**
 * Whether a 400 body refuses `temperature` as a field. A body that names
 * the one allowed value is a different lesson (`parseAllowedTemperature`)
 * and reads as `false` here; so does a refusal that says nothing about
 * temperature near it, or a range error ("must be at most 1").
 */
export function parseTemperatureRefused(text: string): boolean {
  if (parseAllowedTemperature(text) !== undefined) return false;
  for (const match of text.matchAll(FIELD_REFUSED_RE)) {
    const at = match.index ?? 0;
    const from = Math.max(0, at - REFUSAL_NEAR_CHARS);
    const to = at + match[0].length + REFUSAL_NEAR_CHARS;
    if (/temperature/i.test(text.slice(from, to))) return true;
  }
  return false;
}

/**
 * What a failed send teaches about the model's temperature: the one value
 * it takes, that it takes none, or nothing (any other error).
 */
export type TemperatureLesson =
  | { readonly kind: "fixed"; readonly value: number }
  | { readonly kind: "forbidden" };

export function temperatureLessonFromError(
  err: unknown,
): TemperatureLesson | undefined {
  const value = allowedTemperatureFromError(err);
  if (value !== undefined) return { kind: "fixed", value };
  if (!(err instanceof Error)) return undefined;
  if ((err as { status?: unknown }).status !== 400) return undefined;
  return parseTemperatureRefused(err.message) ? { kind: "forbidden" } : undefined;
}
