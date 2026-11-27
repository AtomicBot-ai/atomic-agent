import { describe, expect, it } from "vitest";

import { failureVerdict } from "../../llm/reliability/failure-catalog.js";
import { formatProviderRefusalForChat, isAccountStateFailure } from "./format-provider-refusal-for-chat.js";

describe("formatProviderRefusalForChat (ATO-1673)", () => {
  it("puts the catalog phrase first and the agent's sentence under Details", () => {
    expect(
      formatProviderRefusalForChat(failureVerdict("model_not_found"), '"openrouter" answered 404 (not found).', false),
    ).toBe('Turn failed: The provider doesn\'t have this model.\nDetails: "openrouter" answered 404 (not found).');
  });

  it("appends the fallback note and caps a long body", () => {
    const said = formatProviderRefusalForChat(failureVerdict("request_rejected"), "x".repeat(600), false, " (after a failed)");
    expect(said?.endsWith("… (after a failed)")).toBe(true);
  });

  it("is null for a local route, another cause or no verdict", () => {
    expect(formatProviderRefusalForChat(failureVerdict("out_of_credit"), "m", true)).toBeNull();
    expect(formatProviderRefusalForChat(failureVerdict("offline"), "m", false)).toBeNull();
    expect(formatProviderRefusalForChat(undefined, "m", false)).toBeNull();
  });
});

describe("isAccountStateFailure", () => {
  it("is an empty account or a rate limit only", () => {
    expect(isAccountStateFailure(failureVerdict("out_of_credit"))).toBe(true);
    expect(isAccountStateFailure(failureVerdict("rate_limited"))).toBe(true);
    expect(isAccountStateFailure(failureVerdict("auth_rejected"))).toBe(false);
    expect(isAccountStateFailure(undefined)).toBe(false);
  });
});
