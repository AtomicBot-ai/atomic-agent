/**
 * What a provider said, made safe to put on a status line and in a log.
 *
 * Two rules, both learned the hard way from error bodies:
 *
 *  - Providers echo the offending credential back. The key we sent is
 *    therefore removed by exact match, and anything else shaped like an
 *    API key is removed by pattern — a proxy in front of the service can
 *    quote a *different* key than the one under test, and the exact
 *    match would sail straight past it.
 *  - The body itself is never reproduced whole. A verdict needs a
 *    sentence of evidence, not a provider's entire JSON, which on some
 *    gateways carries request echoes and upstream headers.
 */

/** Same cap the OpenAI HTTP layer uses when folding a body into an error. */
export const PROVIDER_DETAIL_MAX_LEN = 300;

/**
 * Vendor key shapes common enough to be worth removing on sight:
 * OpenAI-style `sk-…`, OpenRouter's `sk-or-…`, Google's `AIza…`, and a
 * bearer token quoted out of an echoed header. Deliberately narrow —
 * a pattern loose enough to catch every possible secret would redact
 * model ids and error codes along with them.
 */
const KEY_SHAPED = [
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\bAIza[A-Za-z0-9_-]{10,}/g,
  /\b[Bb]earer\s+[A-Za-z0-9._-]{8,}/g,
];

export function redactProviderDetail(
  detail: string,
  apiKey = "",
  maxLen: number = PROVIDER_DETAIL_MAX_LEN,
): string {
  // Short strings are not keys; splitting on one would shred ordinary
  // words out of the message.
  let out = apiKey.length >= 8 ? detail.split(apiKey).join("***") : detail;
  for (const pattern of KEY_SHAPED) out = out.replace(pattern, "***");
  return out.slice(0, maxLen);
}
