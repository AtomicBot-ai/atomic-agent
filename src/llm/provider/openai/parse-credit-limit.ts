/**
 * The two token counts an OpenAI-compatible service names when it
 * refuses a request for lack of credit.
 */
export interface CreditLimit {
  /** The `max_tokens` ceiling the service read off our request. */
  requested: number;
  /** The largest ceiling the account's remaining balance can cover. */
  affordable: number;
}

/**
 * Read the affordable `max_tokens` out of a credit-refusal body.
 *
 * OpenRouter answers HTTP 402 with a self-describing sentence:
 *
 * > This request requires more credits, or fewer max_tokens. You
 * > requested up to 65536 tokens, but can only afford 45822.
 *
 * That is not a rate limit and not an outage — the request is simply
 * reserving more output budget than the balance covers, and the service
 * has already told us the number that would work. Parsing it is what
 * lets the client recover without the operator editing any config.
 *
 * This is a **vendor string** and it will drift, so the parser is
 * deliberately isolated and deliberately fails closed: anything it does
 * not recognise returns `null` and the caller surfaces the provider's own
 * error untouched. It never guesses, never falls back to "some smaller
 * number", and rejects results that are not a strict improvement
 * (`affordable >= requested` means the ceiling was not the problem).
 *
 * Matching is tolerant of the surroundings only — leading prose, a JSON
 * envelope, capitalisation, and thousands separators inside the numbers.
 * The two anchors ("requested up to N tokens" and "can only afford M")
 * must both be present, in that order.
 */
export function parseCreditLimit(body: string): CreditLimit | null {
  if (typeof body !== "string" || body.length === 0) return null;
  const match = CREDIT_LIMIT_PATTERN.exec(body);
  if (!match) return null;

  const requested = toCount(match[1]);
  const affordable = toCount(match[2]);
  if (requested === null || affordable === null) return null;
  // Nothing to recover: the ceiling was already within budget, so a
  // retry would re-send the same refusal.
  if (affordable >= requested) return null;
  return { requested, affordable };
}

/**
 * `You requested up to 65536 tokens, but can only afford 45822.`
 *
 * `[\s\S]` rather than `.` between the anchors because a JSON body can
 * carry escaped newlines; the run is bounded so the two halves cannot be
 * stitched together out of unrelated sentences in a long body.
 */
const CREDIT_LIMIT_PATTERN =
  /requested\s+up\s+to\s+([0-9][0-9,_]*)\s+tokens?[\s\S]{0,40}?can\s+only\s+afford\s+([0-9][0-9,_]*)/i;

/** Strip thousands separators and accept only a positive whole number. */
function toCount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const digits = raw.replace(/[,_]/g, "");
  if (!/^[0-9]+$/.test(digits)) return null;
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}
