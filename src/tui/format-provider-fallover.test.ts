import { describe, expect, it } from "vitest";

import {
  classifyFalloverReason,
  formatProviderFalloverNotice,
} from "./format-provider-fallover.js";

describe("classifyFalloverReason", () => {
  it.each([
    '"openrouter" rejected the request (402).',
    "This request requires more credits, or fewer max_tokens",
    "quota exceeded for this month",
  ])("reads %j as a billing refusal", (reason) => {
    expect(classifyFalloverReason(reason)).toBe("billing");
  });

  it.each([
    "provider rejected the request (401).",
    "403 Forbidden",
    "invalid api key",
  ])("reads %j as an auth refusal", (reason) => {
    expect(classifyFalloverReason(reason)).toBe("auth");
  });

  it.each([
    "socket hang up",
    "503 Service Unavailable",
    "timed out after 300000ms",
  ])("leaves %j as transient", (reason) => {
    expect(classifyFalloverReason(reason)).toBe("other");
  });
});

describe("formatProviderFalloverNotice", () => {
  it("names both providers and the reason", () => {
    const text = formatProviderFalloverNotice(
      "openrouter",
      "local-llama",
      "socket hang up",
    );
    expect(text).toContain("openrouter");
    expect(text).toContain("local-llama");
    expect(text).toContain("socket hang up");
  });

  it("says a credit refusal will not clear by itself, and how to act", () => {
    const text = formatProviderFalloverNotice(
      "openrouter",
      "local-llama",
      '"openrouter" rejected the request (402).',
    );
    expect(text).toMatch(/will not clear by itself/);
    expect(text).toContain("maxOutputTokens");
    expect(text).toContain("every answer comes from local-llama");
  });

  it("points an auth refusal at the key file", () => {
    const text = formatProviderFalloverNotice(
      "openrouter",
      "local-llama",
      "401 unauthorized",
    );
    expect(text).toMatch(/will not clear by itself/);
    expect(text).toContain(".env");
  });

  it("keeps a transient failure short — the chain's own probe handles it", () => {
    const text = formatProviderFalloverNotice(
      "openrouter",
      "local-llama",
      "503",
    );
    expect(text).toMatch(/until openrouter recovers/);
    expect(text).not.toMatch(/will not clear by itself/);
  });
});
