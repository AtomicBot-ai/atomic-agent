/**
 * Redaction is the only thing standing between a provider's error body
 * and a status line, so each rule is exercised on a string short enough
 * that the length cap cannot do the work for it. A test whose fixture
 * is longer than `PROVIDER_DETAIL_MAX_LEN` passes with redaction
 * removed entirely, which is worse than no test at all.
 */

import { describe, expect, it } from "vitest";

import {
  PROVIDER_DETAIL_MAX_LEN,
  redactProviderDetail,
} from "./redact-provider-detail.js";

const KEY = "sk-ours-1234567890";

describe("redactProviderDetail", () => {
  it("removes the key we sent, wherever the provider echoed it", () => {
    const detail = redactProviderDetail(
      `invalid key ${KEY} for org (header: Bearer ${KEY})`,
      KEY,
    );

    expect(detail).not.toContain(KEY);
    expect(detail.length).toBeLessThan(PROVIDER_DETAIL_MAX_LEN);
  });

  it("removes a key-shaped string that is not the one under test", () => {
    // The case the exact-match rule cannot reach: a gateway quoting the
    // upstream credential it uses on our behalf. Short on purpose —
    // truncation must not be what hides this.
    const detail = redactProviderDetail(
      "upstream rejected sk-or-v1-abcdef0123456789 (routed)",
      KEY,
    );

    expect(detail).not.toContain("sk-or-v1-abcdef0123456789");
    expect(detail).toContain("upstream rejected");
    expect(detail).toContain("(routed)");
  });

  it("removes Google keys and quoted bearer tokens", () => {
    const detail = redactProviderDetail(
      'API key AIzaSyD-0123456789abcdef invalid; sent "Bearer ghp_0123456789abcd"',
      "",
    );

    expect(detail).not.toContain("AIzaSyD-0123456789abcdef");
    expect(detail).not.toContain("ghp_0123456789abcd");
  });

  it("leaves an ordinary provider message readable", () => {
    // The other half of the contract: a pattern loose enough to redact
    // model ids and error codes would make every verdict unreadable.
    const message =
      "400 InvalidParameter: tool_choice does not support being set to object";
    expect(redactProviderDetail(message, KEY)).toBe(message);
    expect(redactProviderDetail("model deepseek-v4-flash not found", KEY)).toBe(
      "model deepseek-v4-flash not found",
    );
  });

  it("never lets a whole body through, redacted or not", () => {
    const body = `{"error":{"message":"${"detail ".repeat(200)}"}}`;
    expect(redactProviderDetail(body, KEY)).toHaveLength(
      PROVIDER_DETAIL_MAX_LEN,
    );
  });

  it("ignores a key too short to be one, rather than shredding words", () => {
    // `split(apiKey).join("***")` on a 3-character "key" would cut the
    // message to pieces; the length floor is what stops it.
    expect(redactProviderDetail("the model was not found", "the")).toBe(
      "the model was not found",
    );
  });
});
