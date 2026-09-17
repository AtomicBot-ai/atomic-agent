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
