import type { SecurityFinding } from "../../../approval/approval-ledger.js";
import {
  knownSecretsFromEnv,
  maskSecrets,
  type KnownSecret,
} from "../../../error-reporting/secret-detector.js";

/**
 * A secret in what `os.http.request` would send (ATO-2505): the body and
 * the URL's query, read by the shared detector (`secret-detector.ts`).
 * One of the agent's own secrets, word for word (its `.env`, loaded into
 * the environment), is confidence 1: the model never sees those values,
 * so sending one means it read the file or a command printed it. A
 * vendor key shape, a bearer token, a JWT or a `password=...` pair is
 * 0.8. At or above `agent.security.argScanThreshold` the request asks at
 * every approval level, bypass included; below it, it asks as a POST.
 *
 * Headers are left out: an `Authorization` header is how an API is
 * normally called.
 */

export const HTTP_SECRET_RULE = "dangerous.http_secret";
const KNOWN_CONFIDENCE = 1;
const SHAPE_CONFIDENCE = 0.8;

function sentText(url: URL, body: string | undefined): string {
  const query = url.search.length > 1 ? decodeQuery(url.search.slice(1)) : "";
  return [query, body ?? ""].filter((part) => part.length > 0).join("\n");
}

function decodeQuery(query: string): string {
  try {
    return decodeURIComponent(query.replace(/\+/g, " "));
  } catch {
    return query;
  }
}

/** Labels the detector put in place of what it found (`[redacted:openai-key]`). */
function maskedLabels(masked: string): string[] {
  return [...new Set([...masked.matchAll(/\[redacted:([a-z0-9_.-]+)\]/gi)].map((m) => m[1]!))];
}

export function httpSecretFinding(
  url: URL,
  body: string | undefined,
  known: readonly KnownSecret[] = knownSecretsFromEnv(),
): SecurityFinding | null {
  const text = sentText(url, body);
  if (text.length === 0) return null;
  const exact = known.filter((secret) => secret.value.length > 0 && text.includes(secret.value));
  if (exact.length > 0) {
    return {
      rule: HTTP_SECRET_RULE,
      reason: `sends the agent's own secret ${exact.map((s) => s.label).slice(0, 3).join(", ")} to ${url.host}`,
      confidence: KNOWN_CONFIDENCE,
    };
  }
  const masked = maskSecrets(text);
  if (masked === text) return null;
  const labels = maskedLabels(masked);
  return {
    rule: HTTP_SECRET_RULE,
    reason: `sends what looks like a secret (${labels.slice(0, 3).join(", ") || "credential"}) to ${url.host}`,
    confidence: SHAPE_CONFIDENCE,
  };
}

/** The live threshold, or 0.7 when unset or not a number in 0.5..1. */
export function readArgScanThreshold(read: (() => number) | undefined): number {
  try {
    const value = read?.();
    const valid = value !== undefined && Number.isFinite(value) && value >= 0.5 && value <= 1;
    return valid ? value : 0.7;
  } catch {
    return 0.7;
  }
}
