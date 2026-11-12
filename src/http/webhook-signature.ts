import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signature checks for the signed webhook schemes (ATO-438). Both work on
 * the exact request bytes, so the route must read the raw body before it
 * parses JSON. Every comparison is constant-time and never reports which
 * part of a signature was wrong.
 */

/** Standard Webhooks: reject a `webhook-timestamp` this far from now. */
export const STANDARD_WEBHOOKS_TOLERANCE_MS = 5 * 60 * 1000;

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: SignatureFailure };

export type SignatureFailure =
  | "missing_signature"
  | "missing_headers"
  | "bad_timestamp"
  | "stale_timestamp"
  | "bad_signature";

/**
 * GitHub: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the body>`,
 * keyed with the webhook secret as UTF-8.
 */
export function verifyGithubSignature(
  rawBody: Buffer,
  header: string | null,
  secret: string,
): SignatureCheck {
  if (!header) return { ok: false, reason: "missing_signature" };
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!match?.[1]) return { ok: false, reason: "bad_signature" };
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(match[1], "hex");
  return bytesEqual(provided, expected)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" };
}

export interface StandardWebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/**
 * Standard Webhooks (used by Composio, Svix and others): the signed
 * content is `<webhook-id>.<webhook-timestamp>.<body>`, the key is the
 * base64 part of a `whsec_` secret, and `webhook-signature` is a
 * space-separated list of `v1,<base64 HMAC-SHA256>` of which any one may
 * match (that is how senders rotate secrets). The timestamp is Unix
 * seconds and must be within `STANDARD_WEBHOOKS_TOLERANCE_MS` of now in
 * either direction.
 */
export function verifyStandardWebhook(
  rawBody: Buffer,
  headers: StandardWebhookHeaders,
  secret: string,
  nowMs: number,
): SignatureCheck {
  const { id, timestamp, signature } = headers;
  if (!signature) return { ok: false, reason: "missing_signature" };
  if (!id || !timestamp) return { ok: false, reason: "missing_headers" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" };
  const sentMs = Number(timestamp) * 1000;
  if (Math.abs(nowMs - sentMs) > STANDARD_WEBHOOKS_TOLERANCE_MS) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const expected = createHmac("sha256", standardWebhooksKey(secret))
    .update(`${id}.${timestamp}.`)
    .update(rawBody)
    .digest();
  for (const entry of signature.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma < 0 || entry.slice(0, comma) !== "v1") continue;
    const provided = Buffer.from(entry.slice(comma + 1), "base64");
    if (bytesEqual(provided, expected)) return { ok: true };
  }
  return { ok: false, reason: "bad_signature" };
}

/** Key bytes of a Standard Webhooks secret; the `whsec_` prefix is optional. */
export function standardWebhooksKey(secret: string): Buffer {
  const body = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  return Buffer.from(body, "base64");
}

function bytesEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
