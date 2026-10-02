import { describe, expect, it } from "vitest";

import {
  classifyFalloverReason,
  formatFallbackStatusLine,
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

describe("formatFallbackStatusLine", () => {
  const away = (reason: string) =>
    formatFallbackStatusLine({
      direction: "away",
      from: "openrouter",
      to: "local-llama",
      reason,
    });

  it("names a credit refusal and the fix, not the provider's raw text", () => {
    const line = away(
      "This request requires more credits, or fewer max_tokens. You requested up to 96000 tokens (402).",
    );
    expect(line).toContain("failed over openrouter -> local-llama");
    expect(line).toContain("openrouter is out of credit or quota");
    expect(line).toContain("maxOutputTokens");
    expect(line).toContain("(402)");
    expect(line).not.toContain("96000");
  });

  it("names a key refusal and where the key lives", () => {
    const line = away("provider rejected the request (401).");
    expect(line).toContain("openrouter refused the API key");
    expect(line).toContain(".env");
    expect(line).toContain("config.json");
    expect(line).toContain("(401)");
    expect(line).not.toContain("provider rejected");
  });

  it("keeps a transient reason and says the chain retries by itself", () => {
    const line = away("503 Service Unavailable");
    expect(line).toBe(
      "status: failed over openrouter -> local-llama (503 Service Unavailable) · retrying the primary automatically",
    );
    expect(away("request timed out after 120000ms")).toContain(
      "retrying the primary automatically",
    );
  });

  it("promises no retry for a failure that will not clear by itself", () => {
    for (const reason of [
      "model not found (404)",
      "No endpoints found for this model (404)",
      "context length exceeded (400)",
    ]) {
      const line = away(reason);
      expect(line).toBe(
        `status: failed over openrouter -> local-llama (${reason})`,
      );
    }
  });

  it("reports a recovery without a reason", () => {
    expect(
      formatFallbackStatusLine({
        direction: "back",
        from: "local-llama",
        to: "openrouter",
        reason: "primary recovered",
      }),
    ).toBe("status: recovered primary openrouter");
  });
});
