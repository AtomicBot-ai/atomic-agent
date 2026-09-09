import { describe, expect, it } from "vitest";

import { describeReason } from "./provider-fallback-chain.js";

/**
 * The reason text is what an operator reads on a fallover notice and in
 * the feed, so it has to name the refusal rather than the transport that
 * carried it.
 */
describe("the reason an operator is shown for a fallover", () => {
  it("is the provider's own message, not the error class", () => {
    const err = Object.assign(new Error('"openrouter" rejected the request (402).'), {
      name: "OpenAiHttpError",
    });
    expect(describeReason(err)).toBe('"openrouter" rejected the request (402).');
    expect(describeReason(err)).not.toBe("OpenAiHttpError");
  });

  it("collapses whitespace to one line and caps the length", () => {
    const reason = describeReason(new Error("a".repeat(400) + "\n\nsecond line"));
    expect(reason.length).toBeLessThanOrEqual(180);
    expect(reason).not.toContain("\n");
    expect(reason.endsWith("\u2026")).toBe(true);
  });

  it("keeps a multi-line message readable on one row", () => {
    expect(describeReason(new Error("first line\n  second line"))).toBe(
      "first line second line",
    );
  });

  it("falls back to the class name when there is no message", () => {
    expect(describeReason(Object.assign(new Error("   "), { name: "TransportError" }))).toBe(
      "TransportError",
    );
  });

  it("falls back to a plain sentence for anything that is not an error", () => {
    expect(describeReason("not an error at all")).toBe("provider unavailable");
    expect(describeReason(undefined)).toBe("provider unavailable");
  });
});
