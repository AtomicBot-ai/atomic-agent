import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { LINEAR_TIMESTAMP_TOLERANCE_MS, checkLinearTimestamp, verifyLinearSignature } from "./linear-signature.js";

const SECRET = "lin_wh_test_secret";
const body = Buffer.from(JSON.stringify({ type: "Comment", action: "create", webhookTimestamp: 1 }));
const sign = (b: Buffer, secret = SECRET) => createHmac("sha256", secret).update(b).digest("hex");

describe("verifyLinearSignature", () => {
  it("accepts the hex HMAC-SHA256 of the exact body", () => {
    expect(verifyLinearSignature(body, sign(body), SECRET)).toEqual({ ok: true });
    expect(verifyLinearSignature(body, sign(body).toUpperCase(), SECRET)).toEqual({ ok: true });
  });

  it("refuses a signature made with another secret", () => {
    expect(verifyLinearSignature(body, sign(body, "other"), SECRET)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses when the body changed after signing", () => {
    const tampered = Buffer.from(body.toString("utf8").replace("create", "remove"));
    expect(verifyLinearSignature(tampered, sign(body), SECRET).ok).toBe(false);
  });

  it("refuses a missing or malformed header", () => {
    expect(verifyLinearSignature(body, undefined, SECRET)).toEqual({ ok: false, reason: "missing_signature" });
    expect(verifyLinearSignature(body, "sha256=abc", SECRET)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyLinearSignature(body, "00", SECRET)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("never matches with an empty secret", () => {
    expect(verifyLinearSignature(body, sign(body, ""), "").ok).toBe(false);
  });
});

describe("checkLinearTimestamp", () => {
  const now = 1_800_000_000_000;

  it("accepts a timestamp inside the window, either side of now", () => {
    expect(checkLinearTimestamp(now, now)).toEqual({ ok: true });
    expect(checkLinearTimestamp(now - LINEAR_TIMESTAMP_TOLERANCE_MS + 1, now)).toEqual({ ok: true });
    expect(checkLinearTimestamp(now + 5_000, now)).toEqual({ ok: true });
  });

  it("refuses a stale delivery (a replay)", () => {
    expect(checkLinearTimestamp(now - LINEAR_TIMESTAMP_TOLERANCE_MS - 1, now)).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it("refuses a missing or non-numeric timestamp", () => {
    expect(checkLinearTimestamp(undefined, now)).toEqual({ ok: false, reason: "bad_timestamp" });
    expect(checkLinearTimestamp(String(now), now)).toEqual({ ok: false, reason: "bad_timestamp" });
  });
});
