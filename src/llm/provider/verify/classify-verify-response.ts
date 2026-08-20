/**
 * Turning one HTTP answer into a verdict about the key.
 *
 * Providers disagree on how they say "no money" and "wrong key": OpenAI
 * sends 429 `insufficient_quota`, OpenRouter 402, Anthropic-style
 * gateways 403 with billing wording, and Gemini answers a 400 for a bad
 * key rather than a 401. The status code alone is therefore not enough,
 * so the body is consulted for wording before falling back to the code.
 */

import { OpenAiHttpError } from "../openai/openai-http.js";
import type { ProviderVerifyStatus } from "./verify-types.js";

export type VerifyResponseVerdict =
  | { readonly kind: "status"; readonly status: ProviderVerifyStatus }
  /** Same model, resend with the other max-tokens field. */
  | { readonly kind: "retry_token_field" }
  /** This model is unusable for this key; try the next candidate. */
  | { readonly kind: "retry_next_model" };

const BILLING_WORDING =
  /insufficient|quota|credit|billing|payment|balance|top ?up|out of funds|resource[_ ]exhausted/;
const KEY_WORDING =
  /api[_ ]?key|unauthenticated|unauthorized|invalid authentication|permission denied/;
const MISSING_MODEL_WORDING =
  /model.{0,40}(not found|does not exist|is not available|unknown|unsupported|invalid)|(not found|unknown|unsupported).{0,20}model/;
const TOKEN_FIELD_WORDING = /max_tokens|max_completion_tokens/;

export function classifyVerifyResponse(
  httpStatus: number,
  body: string,
): VerifyResponseVerdict {
  if (httpStatus >= 200 && httpStatus < 300) {
    // A completion came back, so the account could pay for the token it
    // just spent. That is the whole point of probing with a paid model.
    return { kind: "status", status: "ok" };
  }
  const text = body.toLowerCase();

  if (httpStatus === 402) return verdict("no_balance");

  if (httpStatus === 401 || httpStatus === 403) {
    // Services that bill by prepaid credit answer 401/403 once the
    // balance is gone, with a key that is otherwise perfectly valid.
    return verdict(BILLING_WORDING.test(text) ? "no_balance" : "invalid_key");
  }

  if (httpStatus === 429) {
    // Only a quota/credit refusal is a money problem. A bare 429 is the
    // provider asking us to slow down, which proves the key works.
    return verdict(BILLING_WORDING.test(text) ? "no_balance" : "rate_limited");
  }

  if (httpStatus === 404) return { kind: "retry_next_model" };

  if (httpStatus === 400) {
    // Gemini's OpenAI-compatible surface answers 400 INVALID_ARGUMENT
    // for a bad key instead of 401.
    if (KEY_WORDING.test(text)) return verdict("invalid_key");
    if (BILLING_WORDING.test(text)) return verdict("no_balance");
    if (MISSING_MODEL_WORDING.test(text)) return { kind: "retry_next_model" };
    // Newer OpenAI models reject `max_tokens` and want
    // `max_completion_tokens`; that is our request being wrong, not the
    // key, so the same model gets one more chance with the other field.
    if (TOKEN_FIELD_WORDING.test(text)) return { kind: "retry_token_field" };
  }

  return verdict("provider_error");
}

/** A thrown transport failure, which says nothing about the key itself. */
export function classifyVerifyTransportError(err: unknown): ProviderVerifyStatus {
  if (err instanceof OpenAiHttpError) {
    if (err.timedOut) return "timeout";
    if (err.status === null) return "unreachable";
    return "provider_error";
  }
  if (isAbortError(err)) return "cancelled";
  return "unreachable";
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

function verdict(status: ProviderVerifyStatus): VerifyResponseVerdict {
  return { kind: "status", status };
}
