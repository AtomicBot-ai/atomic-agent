import type { OpenAiHttpError } from "./openai-http.js";

/**
 * Groq's answer to a request bigger than the account's tokens-per-minute
 * allowance (ATO-1283): HTTP 413 with a body like
 *
 *   {"error":{"message":"Request too large for model `llama-3.3-70b-versatile`
 *   in organization `org_…` service tier `on_demand` on tokens per minute
 *   (TPM): Limit 12000, Requested 15639, please reduce your message size and
 *   try again. …","type":"tokens","code":"rate_limit_exceeded"}}
 *
 * A small plan's allowance can be smaller than one agent turn with its
 * tools. The tier is not known from the answer (`on_demand` is both the
 * free and the paid Dev Tier), so the user is told "your Groq plan". Only
 * a 413 that carries Groq's TPM numbers is known to be that limit and is
 * kept out of error reporting (`isGroqPlanTpmLimit`); a bare 413 ("Request
 * Entity Too Large") may be a payload refusal and is still reported.
 */

/** Groq's API host (the `groq` preset's base URL). */
const GROQ_HOST = "api.groq.com";

/** A provider entry id for Groq: `groq`, or a second key's `groq-2`. */
const GROQ_ENTRY_ID = /^groq(?:-\d+)?$/i;

/** "Limit 12000, Requested 15639" out of Groq's sentence. */
const LIMIT_AND_REQUESTED = /\bLimit:?\s*([\d,]+)\D{1,20}?Requested:?\s*([\d,]+)/i;

function isGroqTarget(err: OpenAiHttpError): boolean {
  try {
    if (new URL(err.url).hostname.toLowerCase() === GROQ_HOST) return true;
  } catch {
    // Not a URL: fall through to the entry id.
  }
  return GROQ_ENTRY_ID.test(err.providerLabel);
}

/** Groq refused THIS request because it is larger than the plan allows. */
export function isGroqRequestTooLarge(err: OpenAiHttpError): boolean {
  return err.status === 413 && err.streamError === undefined && isGroqTarget(err);
}

/** Groq's TPM numbers ("Limit 12000, Requested 15639") in the answer, or null. */
function limitAndRequested(err: OpenAiHttpError): { limit: string; requested: string } | null {
  const text = `${err.body?.message ?? ""}\n${err.body?.text ?? ""}\n${err.message}`;
  const match = LIMIT_AND_REQUESTED.exec(text);
  return match ? { limit: match[1]!.replace(/,/g, ""), requested: match[2]!.replace(/,/g, "") } : null;
}

/**
 * The 413 is Groq's tokens-per-minute plan limit, proven by its own
 * numbers: an expected limit, not a defect, so not reported.
 */
export function isGroqPlanTpmLimit(err: OpenAiHttpError): boolean {
  return isGroqRequestTooLarge(err) && limitAndRequested(err) !== null;
}

/**
 * What the user reads in chat. Keeps "(413)" so the desktop still reads it
 * as the provider having replied; the numbers are Groq's own when it gave
 * them. Without them the plan limit is not claimed.
 */
export function groqRequestTooLargeSentence(err: OpenAiHttpError): string {
  const n = limitAndRequested(err);
  if (n === null) {
    return (
      "Groq refused the request (413): it is too large for Groq. " +
      "Start a new chat or pick a model with a higher limit."
    );
  }
  return (
    `Groq refused the request (413): it is larger than your Groq plan's limit ` +
    `(limit ${n.limit} tokens per minute, this request ${n.requested}). ` +
    `Pick a model with a higher limit or a larger Groq plan.`
  );
}
