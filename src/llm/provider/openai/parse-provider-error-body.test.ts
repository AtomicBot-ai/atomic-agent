import { describe, expect, it } from "vitest";
import {
  IN_FLIGHT_BUDGET_DEFAULT_WAIT_MS,
  parseProviderErrorBody,
  readProviderErrorReason,
} from "./parse-provider-error-body.js";

describe("parseProviderErrorBody", () => {
  it("reads the OpenAI shape", () => {
    const body = parseProviderErrorBody(
      JSON.stringify({
        error: {
          message: "You exceeded your current quota",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      }),
    );
    expect(body).toMatchObject({
      message: "You exceeded your current quota",
      type: "insufficient_quota",
      code: "insufficient_quota",
    });
    expect(body.retryHintMs).toBeUndefined();
  });

  it("reads the OpenRouter shape, including the upstream raw body", () => {
    const body = parseProviderErrorBody(
      JSON.stringify({
        error: {
          message: "Provider returned error",
          code: 429,
          metadata: {
            provider_name: "Anthropic",
            raw: '{"type":"error","error":{"type":"credit_balance_exhausted","message":"Your credit balance is too low"}}',
          },
        },
      }),
    );
    expect(body.code).toBe("429");
    expect(body.upstream).toBe("Anthropic");
    expect(body.text).toContain("credit_balance_exhausted");
  });

  it.each([
    ["retry in 120 s", 120_000],
    ["Please retry after 2 minutes.", 120_000],
    ["try again in 30 seconds", 30_000],
    ["retry in 500ms", 500],
    ["Retry the request in 1.5s", 1_500],
  ])("reads a textual cooldown: %s", (text, ms) => {
    expect(
      parseProviderErrorBody(JSON.stringify({ error: { message: text } }))
        .retryHintMs,
    ).toBe(ms);
  });

  it("copes with a body that is not JSON", () => {
    const body = parseProviderErrorBody("<html>Bad gateway</html>");
    expect(body.text).toBe("<html>Bad gateway</html>");
    expect(body.message).toBeUndefined();
  });

  it("reads the message a body with no error object carries at the top (AI/ML API)", () => {
    const body = parseProviderErrorBody(
      JSON.stringify({
        title: "Forbidden",
        status: 403,
        message:
          "You've run out of funds. Please top up your balance or update your payment method to continue: https://aimlapi.com/app/billing",
      }),
    );
    expect(body.message).toBe(
      "You've run out of funds. Please top up your balance or update your payment method to continue: https://aimlapi.com/app/billing",
    );
    // An error object wins, as before.
    expect(
      parseProviderErrorBody(
        JSON.stringify({ message: "outer", error: { message: "inner" } }),
      ).message,
    ).toBe("inner");
  });
});

describe("readProviderErrorReason", () => {
  const read = (
    status: number | null,
    text: string,
    retryAfterMs: number | null = null,
  ) =>
    readProviderErrorReason({
      status,
      body: parseProviderErrorBody(text),
      message: `openai provider ${status}: ${text.slice(0, 300)}`,
      retryAfterMs,
    });

  it("reads exhausted credit off a 429 that OpenRouter relays for Anthropic", () => {
    // The Codex attempt: retried 42 times per worker as rate limiting.
    expect(
      read(
        429,
        JSON.stringify({
          error: {
            message: "Provider returned error",
            code: 429,
            metadata: {
              raw: '{"error":{"type":"credit_balance_exhausted","message":"Your credit balance is too low"}}',
            },
          },
        }),
        30_000,
      ),
    ).toEqual({ kind: "credit_exhausted", code: "credit_balance_exhausted" });
  });

  it("reads exhausted credit off OpenAI's insufficient_quota and OpenRouter's insufficient_credits", () => {
    expect(
      read(429, JSON.stringify({ error: { code: "insufficient_quota" } })),
    ).toEqual({ kind: "credit_exhausted", code: "insufficient_quota" });
    expect(
      read(402, JSON.stringify({ error: { code: "insufficient_credits" } })),
    ).toEqual({ kind: "credit_exhausted", code: "insufficient_credits" });
  });

  it("treats a 402 that talks about credit as exhausted credit", () => {
    expect(
      read(
        402,
        JSON.stringify({
          error: {
            message:
              "This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 900.",
          },
        }),
      ),
    ).toEqual({ kind: "credit_exhausted", code: "402" });
  });

  it("honours OpenRouter's in-flight budget with its hint, or a default wait", () => {
    expect(
      read(
        402,
        JSON.stringify({
          error: {
            code: "in_flight_budget_exhausted",
            message: "Too many requests in flight for your balance; retry in 120 s",
          },
        }),
      ),
    ).toEqual({
      kind: "retry_after",
      delayMs: 120_000,
      code: "in_flight_budget_exhausted",
    });
    expect(
      read(
        402,
        JSON.stringify({ error: { code: "in_flight_budget_exhausted" } }),
      ),
    ).toEqual({
      kind: "retry_after",
      delayMs: IN_FLIGHT_BUDGET_DEFAULT_WAIT_MS,
      code: "in_flight_budget_exhausted",
    });
  });

  it("turns a retry-after header on a 429 into a wait, and a plain 429 into nothing", () => {
    expect(
      read(429, JSON.stringify({ error: { message: "rate limited" } }), 7_000),
    ).toEqual({ kind: "retry_after", delayMs: 7_000, code: null });
    expect(read(429, JSON.stringify({ error: { message: "rate limited" } }))).toBeNull();
  });

  it("reads a textual cooldown off a 503", () => {
    expect(
      read(503, JSON.stringify({ error: { message: "overloaded, retry in 5 s" } })),
    ).toEqual({ kind: "retry_after", delayMs: 5_000, code: null });
  });

  it("ignores cooldown wording on a status that is not a cooldown", () => {
    expect(
      read(400, JSON.stringify({ error: { message: "bad request; retry in 5 s" } })),
    ).toBeNull();
    expect(read(401, "", 5_000)).toBeNull();
  });

  /* Item 40: a billing refusal that names no code. AI/ML API answered
     403 "You've run out of funds", which read as nothing at all, so the
     turn fell over to a stopped local server and parked on it. */
  describe("an account that cannot pay, in words", () => {
    const AIML_403 = JSON.stringify({
      title: "Forbidden",
      status: 403,
      message:
        "You've run out of funds. Please top up your balance or update your payment method to continue: https://aimlapi.com/app/billing",
    });

    it("reads AI/ML API's 403 as exhausted credit", () => {
      expect(read(403, AIML_403)).toEqual({ kind: "credit_exhausted", code: "403" });
    });

    it("reads a 403 about billing or the payment method the same way", () => {
      expect(
        read(403, JSON.stringify({ error: { message: "Billing is not enabled for this account." } })),
      ).toEqual({ kind: "credit_exhausted", code: "403" });
    });

    it("leaves a 403 about the key or the input alone", () => {
      expect(
        read(403, JSON.stringify({ error: { message: "Invalid API key provided" } })),
      ).toBeNull();
      // Billing words beside the key's are about the key.
      expect(
        read(
          403,
          JSON.stringify({ error: { message: "Invalid API key. Check your billing settings." } }),
        ),
      ).toBeNull();
      expect(
        read(
          403,
          JSON.stringify({
            error: { message: "Your chosen model requires moderation and your input was flagged" },
          }),
        ),
      ).toBeNull();
    });

    it("reads any 402 that asked for no cooldown as the account, whatever its words", () => {
      expect(read(402, JSON.stringify({ error: { message: "Insufficient Balance" } }))).toEqual({
        kind: "credit_exhausted",
        code: "402",
      });
      expect(read(402, "")).toEqual({ kind: "credit_exhausted", code: "402" });
      expect(read(402, "{}")).toEqual({ kind: "credit_exhausted", code: "402" });
    });

    it("keeps a 402 that asked for a cooldown, and the in-flight budget, a wait", () => {
      expect(
        read(402, JSON.stringify({ error: { message: "Server busy, retry in 5 s" } })),
      ).toEqual({ kind: "retry_after", delayMs: 5_000, code: null });
      expect(
        read(402, JSON.stringify({ error: { code: "in_flight_budget_exhausted", message: "for your balance" } })),
      ).toMatchObject({ kind: "retry_after", code: "in_flight_budget_exhausted" });
    });

    it("reads a 429 that says the account is empty and asks for no cooldown as exhausted credit", () => {
      expect(
        read(
          429,
          JSON.stringify({
            error: {
              message:
                "Your account is suspended due to insufficient balance, please recharge your account or check your plan and billing details",
              type: "exceeded_current_quota_error",
            },
          }),
        ),
      ).toEqual({ kind: "credit_exhausted", code: "429" });
    });

    it("keeps an ordinary 429 rate limit transient, quota and billing words included", () => {
      // Gemini's free tier: a per-minute limit in billing words, with a cooldown.
      const gemini = JSON.stringify({
        error: {
          code: 429,
          message:
            "You exceeded your current quota, please check your plan and billing details. Please retry in 33.5s.",
          status: "RESOURCE_EXHAUSTED",
        },
      });
      expect(read(429, gemini)).toEqual({
        kind: "retry_after",
        delayMs: 33_500,
        code: "429",
      });
      // The same words without a cooldown are still not an empty account.
      expect(
        read(
          429,
          JSON.stringify({
            error: { message: "You exceeded your current quota, please check your plan and billing details." },
          }),
        ),
      ).toBeNull();
      expect(read(429, JSON.stringify({ error: { message: "Rate limit exceeded" } }))).toBeNull();
      // A cooldown the provider asked for wins over its words.
      expect(
        read(429, JSON.stringify({ error: { message: "Out of credits for this minute" } }), 7_000),
      ).toEqual({ kind: "retry_after", delayMs: 7_000, code: null });
    });
  });

  it("falls back to the error's own message when no body was kept", () => {
    expect(
      readProviderErrorReason({
        status: 429,
        body: undefined,
        message:
          'openai provider 429: {"error":{"type":"credit_balance_exhausted"}}',
        retryAfterMs: null,
      }),
    ).toEqual({ kind: "credit_exhausted", code: "credit_balance_exhausted" });
  });
});
