import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  STANDARD_WEBHOOKS_TOLERANCE_MS,
  STRIPE_TOLERANCE_MS,
  standardWebhooksKey,
  verifyGithubSignature,
  verifyStandardWebhook,
  verifyStripeSignature,
} from "./webhook-signature.js";

const BODY = Buffer.from(JSON.stringify({ action: "opened", number: 7 }));
const GITHUB_SECRET = "synthetic-github-secret";
const KEY = Buffer.from("synthetic-standard-key-bytes");
const STANDARD_SECRET = `whsec_${KEY.toString("base64")}`;
const NOW_MS = 1_800_000_000_000;
const NOW_S = String(NOW_MS / 1000);

function githubHeader(body: Buffer, secret = GITHUB_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function standardSig(id: string, ts: string, body: Buffer, key = KEY): string {
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body.toString("utf8")}`).digest("base64")}`;
}

describe("verifyGithubSignature", () => {
  it("accepts the HMAC of the exact body", () => {
    expect(verifyGithubSignature(BODY, githubHeader(BODY), GITHUB_SECRET)).toEqual({ ok: true });
  });

  it("accepts upper-case hex", () => {
    expect(verifyGithubSignature(BODY, githubHeader(BODY).toUpperCase().replace("SHA256=", "sha256="), GITHUB_SECRET).ok).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(verifyGithubSignature(BODY, null, GITHUB_SECRET)).toEqual({ ok: false, reason: "missing_signature" });
  });

  it.each([
    ["another secret", githubHeader(BODY, "other-secret")],
    ["a changed body", githubHeader(Buffer.from('{"action":"closed","number":7}'))],
    ["the legacy sha1 form", `sha1=${createHmac("sha1", GITHUB_SECRET).update(BODY).digest("hex")}`],
    ["a truncated digest", githubHeader(BODY).slice(0, 40)],
    ["no prefix", githubHeader(BODY).slice("sha256=".length)],
  ])("rejects %s", (_label, header) => {
    expect(verifyGithubSignature(BODY, header, GITHUB_SECRET)).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("verifyStandardWebhook", () => {
  const id = "msg_synthetic_1";

  it("accepts a valid v1 signature", () => {
    const check = verifyStandardWebhook(BODY, { id, timestamp: NOW_S, signature: standardSig(id, NOW_S, BODY) }, STANDARD_SECRET, NOW_MS);
    expect(check).toEqual({ ok: true });
  });

  it("accepts any matching entry of a rotated signature list", () => {
    const signature = `v1,${Buffer.from("stale").toString("base64")} v2,ignored ${standardSig(id, NOW_S, BODY)}`;
    expect(verifyStandardWebhook(BODY, { id, timestamp: NOW_S, signature }, STANDARD_SECRET, NOW_MS).ok).toBe(true);
  });

  it("uses the same key with or without the whsec_ prefix", () => {
    expect(standardWebhooksKey(STANDARD_SECRET)).toEqual(KEY);
    expect(standardWebhooksKey(KEY.toString("base64"))).toEqual(KEY);
  });

  it("rejects a signature made with another key", () => {
    const signature = standardSig(id, NOW_S, BODY, Buffer.from("other-key"));
    expect(verifyStandardWebhook(BODY, { id, timestamp: NOW_S, signature }, STANDARD_SECRET, NOW_MS)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a changed body, id or timestamp", () => {
    const signature = standardSig(id, NOW_S, BODY);
    const otherBody = Buffer.from('{"action":"closed"}');
    expect(verifyStandardWebhook(otherBody, { id, timestamp: NOW_S, signature }, STANDARD_SECRET, NOW_MS).ok).toBe(false);
    expect(verifyStandardWebhook(BODY, { id: "msg_other", timestamp: NOW_S, signature }, STANDARD_SECRET, NOW_MS).ok).toBe(false);
    const ts = String(NOW_MS / 1000 + 1);
    expect(verifyStandardWebhook(BODY, { id, timestamp: ts, signature }, STANDARD_SECRET, NOW_MS).ok).toBe(false);
  });

  it("rejects missing headers", () => {
    const signature = standardSig(id, NOW_S, BODY);
    expect(verifyStandardWebhook(BODY, { id, timestamp: NOW_S, signature: null }, STANDARD_SECRET, NOW_MS)).toEqual({ ok: false, reason: "missing_signature" });
    expect(verifyStandardWebhook(BODY, { id: null, timestamp: NOW_S, signature }, STANDARD_SECRET, NOW_MS)).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifyStandardWebhook(BODY, { id, timestamp: null, signature }, STANDARD_SECRET, NOW_MS)).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("rejects a non-numeric timestamp", () => {
    const ts = "2027-01-15T00:00:00Z";
    const signature = standardSig(id, ts, BODY);
    expect(verifyStandardWebhook(BODY, { id, timestamp: ts, signature }, STANDARD_SECRET, NOW_MS)).toEqual({ ok: false, reason: "bad_timestamp" });
  });

  it("rejects a timestamp older or newer than the tolerance, even when signed", () => {
    const toleranceS = STANDARD_WEBHOOKS_TOLERANCE_MS / 1000;
    for (const offset of [-(toleranceS + 1), toleranceS + 1]) {
      const ts = String(NOW_MS / 1000 + offset);
      const signature = standardSig(id, ts, BODY);
      expect(verifyStandardWebhook(BODY, { id, timestamp: ts, signature }, STANDARD_SECRET, NOW_MS)).toEqual({ ok: false, reason: "stale_timestamp" });
    }
  });

  it("accepts a timestamp at the edge of the tolerance", () => {
    const ts = String(NOW_MS / 1000 - STANDARD_WEBHOOKS_TOLERANCE_MS / 1000);
    const signature = standardSig(id, ts, BODY);
    expect(verifyStandardWebhook(BODY, { id, timestamp: ts, signature }, STANDARD_SECRET, NOW_MS).ok).toBe(true);
  });
});

describe("verifyStripeSignature (ATO-625)", () => {
  const STRIPE_SECRET = "whsec_synthetic-stripe-secret";
  const stripeV1 = (t: string, body: Buffer, secret = STRIPE_SECRET): string =>
    createHmac("sha256", secret).update(`${t}.${body.toString("utf8")}`).digest("hex");

  it("accepts the HMAC of `<t>.<body>` keyed with the secret as text", () => {
    const header = `t=${NOW_S},v1=${stripeV1(NOW_S, BODY)}`;
    expect(verifyStripeSignature(BODY, header, STRIPE_SECRET, NOW_MS)).toEqual({ ok: true });
  });

  it("accepts any one of several v1 entries (secret roll)", () => {
    const header = `t=${NOW_S},v1=${stripeV1(NOW_S, BODY, "whsec_old")},v1=${stripeV1(NOW_S, BODY)}`;
    expect(verifyStripeSignature(BODY, header, STRIPE_SECRET, NOW_MS).ok).toBe(true);
  });

  it("rejects a missing header, a missing or malformed t", () => {
    expect(verifyStripeSignature(BODY, null, STRIPE_SECRET, NOW_MS)).toEqual({ ok: false, reason: "missing_signature" });
    expect(verifyStripeSignature(BODY, `v1=${stripeV1(NOW_S, BODY)}`, STRIPE_SECRET, NOW_MS)).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifyStripeSignature(BODY, "t=soon,v1=00", STRIPE_SECRET, NOW_MS)).toEqual({ ok: false, reason: "bad_timestamp" });
  });

  it("rejects a timestamp more than 5 minutes off, even when correctly signed", () => {
    const old = String((NOW_MS - STRIPE_TOLERANCE_MS - 60_000) / 1000);
    const header = `t=${old},v1=${stripeV1(old, BODY)}`;
    expect(verifyStripeSignature(BODY, header, STRIPE_SECRET, NOW_MS)).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects a changed body, a wrong secret and a v0-only header", () => {
    const header = `t=${NOW_S},v1=${stripeV1(NOW_S, BODY)}`;
    expect(verifyStripeSignature(Buffer.from("{}"), header, STRIPE_SECRET, NOW_MS)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyStripeSignature(BODY, header, "whsec_other", NOW_MS)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyStripeSignature(BODY, `t=${NOW_S},v0=${stripeV1(NOW_S, BODY)}`, STRIPE_SECRET, NOW_MS)).toEqual({ ok: false, reason: "bad_signature" });
  });
});
