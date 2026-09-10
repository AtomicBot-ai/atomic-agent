import { describe, it, expect } from "vitest";

import {
  CREDIT_LIMIT_MIN_MAX_TOKENS,
  creditLimitRetryContext,
  creditLimitRetryMessage,
  planCreditLimitRetry,
} from "./plan-credit-limit-retry.js";

function refusal(affordable: number, requested = 65536, status: number | null = 402) {
  return {
    status,
    message:
      `openai provider 402: This request requires more credits, or fewer ` +
      `max_tokens. You requested up to ${requested} tokens, but can only ` +
      `afford ${affordable}.`,
  };
}

describe("planCreditLimitRetry", () => {
  it("plans a retry below the affordable ceiling, keeping headroom", () => {
    const plan = planCreditLimitRetry(refusal(45822));
    expect(plan).not.toBeNull();
    expect(plan?.requestedMaxTokens).toBe(65536);
    expect(plan?.affordableMaxTokens).toBe(45822);
    // Strictly under what the balance covers, and still a usable ceiling.
    expect(plan?.retryMaxTokens).toBeLessThan(45822);
    expect(plan?.retryMaxTokens).toBeGreaterThanOrEqual(
      CREDIT_LIMIT_MIN_MAX_TOKENS,
    );
  });

  it("declines any status other than 402", () => {
    expect(planCreditLimitRetry(refusal(45822, 65536, 429))).toBeNull();
    expect(planCreditLimitRetry(refusal(45822, 65536, 400))).toBeNull();
    expect(planCreditLimitRetry(refusal(45822, 65536, null))).toBeNull();
  });

  it("declines a 402 whose body it cannot parse", () => {
    expect(
      planCreditLimitRetry({
        status: 402,
        message: "openai provider 402: Payment Required",
      }),
    ).toBeNull();
  });

  it("declines when the affordable ceiling is below the usable floor", () => {
    expect(planCreditLimitRetry(refusal(CREDIT_LIMIT_MIN_MAX_TOKENS - 1))).toBeNull();
    // The floor itself is still worth trying.
    expect(planCreditLimitRetry(refusal(CREDIT_LIMIT_MIN_MAX_TOKENS))).not.toBeNull();
  });

  it("never plans a retry below the floor even after headroom", () => {
    const plan = planCreditLimitRetry(refusal(CREDIT_LIMIT_MIN_MAX_TOKENS));
    expect(plan?.retryMaxTokens).toBe(CREDIT_LIMIT_MIN_MAX_TOKENS);
  });

  it("names the balance as the constraint in the warning", () => {
    const plan = planCreditLimitRetry(refusal(45822));
    expect(plan).not.toBeNull();
    const message = creditLimitRetryMessage("openrouter", plan!);
    expect(message).toContain("openrouter");
    expect(message).toContain("402");
    expect(message).toContain("65536");
    expect(message).toContain("45822");
    expect(message).toContain(String(plan!.retryMaxTokens));
    expect(message.toLowerCase()).toContain("balance");
    expect(creditLimitRetryContext("openrouter", plan!)).toEqual({
      provider: "openrouter",
      requestedMaxTokens: 65536,
      affordableMaxTokens: 45822,
      retryMaxTokens: plan!.retryMaxTokens,
    });
  });
});
