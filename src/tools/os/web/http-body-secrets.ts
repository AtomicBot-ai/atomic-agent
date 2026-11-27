import type { SecurityFinding } from "../../../approval/approval-ledger.js";
import {
  knownSecretsFromEnv,
  maskSecrets,
  type KnownSecret,
} from "../../../error-reporting/secret-detector.js";

/**
 * A secret in what `os.http.request` would send (ATO-2505): the body and
 * the whole URL (path, user and password, host labels, query), decoded,
 * read by the shared detector (`secret-detector.ts`).
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

/** `%XX` runs decoded where they form valid UTF-8; anything else is kept as written. */
function percentDecode(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** A form-encoded value: `+` is a space, then `%XX` decoded. */
const formDecode = (text: string): string => percentDecode(text.replace(/\+/g, " "));

/**
 * Every part of the request that leaves the machine, decoded (review
 * round 1 of ATO-2505): the path, the user and password before `@`, each
 * host label (`<token>.attacker.tld`), the query and the body, the body
 * also with its `%XX` escapes undone. Last, the last query value and the
 * body run together with nothing between them, so a token cut in two, its
 * head at the end of the query and its tail at the start of the body,
 * reads whole again.
 */
function sentParts(url: URL, body: string | undefined): string[] {
  const query = url.search.length > 1 ? url.search.slice(1) : "";
  const lastPair = query.slice(query.lastIndexOf("&") + 1);
  const lastValue = formDecode(lastPair.slice(lastPair.indexOf("=") + 1));
  const decodedBody = body === undefined ? "" : formDecode(body);
  return [
    percentDecode(url.pathname),
    percentDecode(url.username),
    percentDecode(url.password),
    url.hostname.split(".").join("\n"),
    formDecode(query),
    body ?? "",
    decodedBody === body ? "" : decodedBody,
    lastValue.length > 0 && decodedBody.length > 0 ? lastValue + decodedBody : "",
  ].filter((part) => part.length > 1);
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
  const text = sentParts(url, body).join("\n");
  if (text.length === 0) return null;
  // Host names arrive lowercased from `URL`, so the agent's own secret is
  // also looked for case-folded there.
  const host = url.hostname;
  const exact = known.filter(
    (secret) =>
      secret.value.length > 0 &&
      (text.includes(secret.value) || host.includes(secret.value.toLowerCase())),
  );
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

/**
 * The live threshold, or 0.7 when unset or not a number in 0.5..1. A
 * value above 0.7 reads as 0.7: the setting only makes the check
 * stricter, so a config edit cannot quiet these asks (review round 1).
 */
export function readArgScanThreshold(read: (() => number) | undefined): number {
  try {
    const value = read?.();
    const valid = value !== undefined && Number.isFinite(value) && value >= 0.5 && value <= 1;
    return valid ? Math.min(value, 0.7) : 0.7;
  } catch {
    return 0.7;
  }
}
