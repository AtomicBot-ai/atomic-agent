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
 * The free tier's allowance is smaller than one agent turn with its tools,
 * so this is the plan's limit, not a fault of ours: the user is told what
 * it is and what helps, and it is not sent to error reporting.
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

/**
 * What the user reads in chat. Keeps "(413)" so the desktop still reads it
 * as the provider having replied; the numbers are Groq's own when it gave
 * them.
 */
export function groqRequestTooLargeSentence(err: OpenAiHttpError): string {
  const text = `${err.body?.message ?? ""}\n${err.body?.text ?? ""}\n${err.message}`;
  const match = LIMIT_AND_REQUESTED.exec(text);
  const numbers = match
    ? ` (limit ${match[1]!.replace(/,/g, "")} tokens per minute, this request ${match[2]!.replace(/,/g, "")})`
    : "";
  return (
    `Groq refused the request (413): it is larger than the Groq free tier limit${numbers}. ` +
    `Pick a model with a higher limit or upgrade the Groq plan.`
  );
}
