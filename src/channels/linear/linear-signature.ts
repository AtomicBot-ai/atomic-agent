import { createHmac, timingSafeEqual } from "node:crypto";

/** Same shape as `SignatureCheck` in `src/http/webhook-signature.ts`. */
export type LinearSignatureCheck =
  | { ok: true }
  | { ok: false; reason: "missing_signature" | "bad_signature" | "bad_timestamp" | "stale_timestamp" };
type SignatureCheck = LinearSignatureCheck;

/**
 * Linear webhook signature (ATO-2324): `Linear-Signature` is the hex
 * HMAC-SHA256 of the exact request bytes, keyed with the webhook's
 * signing secret as UTF-8. Linear also puts `webhookTimestamp` (ms) in
 * the body and asks receivers to refuse one more than a minute old, so a
 * captured delivery cannot be replayed later. Same check as the Cline
 * CLI Linear connector (Apache-2.0, `adapters/linear.ts`) and Linear's
 * own `@linear/sdk` webhook helper. Constant-time; never says which part
 * was wrong.
 */

/** Linear's documented freshness window for `webhookTimestamp`. */
export const LINEAR_TIMESTAMP_TOLERANCE_MS = 60 * 1000;

export function verifyLinearSignature(
  rawBody: Buffer,
  header: string | null | undefined,
  secret: string,
): SignatureCheck {
  if (!header) return { ok: false, reason: "missing_signature" };
  const trimmed = header.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) return { ok: false, reason: "bad_signature" };
  if (secret.length === 0) return { ok: false, reason: "bad_signature" };
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(trimmed, "hex");
  if (provided.length !== expected.length) return { ok: false, reason: "bad_signature" };
  return timingSafeEqual(provided, expected) ? { ok: true } : { ok: false, reason: "bad_signature" };
}

/**
 * `webhookTimestamp` must be a number of ms within the tolerance of now,
 * in either direction (clock skew). A missing one is refused: every
 * Linear delivery carries it.
 */
export function checkLinearTimestamp(webhookTimestamp: unknown, nowMs: number): SignatureCheck {
  if (typeof webhookTimestamp !== "number" || !Number.isFinite(webhookTimestamp)) {
    return { ok: false, reason: "bad_timestamp" };
  }
  return Math.abs(nowMs - webhookTimestamp) > LINEAR_TIMESTAMP_TOLERANCE_MS
    ? { ok: false, reason: "stale_timestamp" }
    : { ok: true };
}
