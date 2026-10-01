import { describe, expect, it } from "vitest";

import { LlamaServerError } from "../llama-server-client.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { SubscriptionCliAuthError } from "../provider/subscription-cli/subscription-cli-errors.js";
import { ModelError } from "../reliability/llm-failures.js";
import { isCredentialRejection, isOutageFailure } from "./link-failure-kind.js";

function http(
  status: number | null,
  message = "boom",
  timedOut = false,
): OpenAiHttpError {
  return new OpenAiHttpError(message, status, "http://x/y", timedOut, null, "p");
}

describe("isCredentialRejection", () => {
  it("is a cloud 401: the key is wrong, missing, or could not be sent", () => {
    expect(isCredentialRejection(http(401))).toBe(true);
    expect(
      isCredentialRejection(
        new OpenAiHttpError(
          "API key contains non-ASCII characters. Use a plain ASCII key.",
          401,
          "https://api.aimlapi.com/v1/chat/completions",
          false,
          null,
          "aimlapi",
          undefined,
          { keyProblem: "non_ascii" },
        ),
      ),
    ).toBe(true);
  });

  it("is a 403 only when it is about the key", () => {
    expect(
      isCredentialRejection(
        http(403, 'openai provider 403: {"error":{"message":"Invalid API key provided"}}'),
      ),
    ).toBe(true);
    expect(
      isCredentialRejection(
        new OpenAiHttpError("openai provider 403: forbidden", 403, "http://x/y", false, null, "p", undefined, {
          keyProblem: "missing",
        }),
      ),
    ).toBe(true);
    // OpenRouter's moderation refusal is a 403 about the input, not the key.
    expect(
      isCredentialRejection(
        http(
          403,
          'openai provider 403: {"error":{"message":"Your chosen model requires moderation and your input was flagged"}}',
        ),
      ),
    ).toBe(false);
    expect(isCredentialRejection(http(403))).toBe(false);
  });

  it("is nothing else", () => {
    for (const status of [null, 400, 402, 404, 429, 500, 503]) {
      expect(isCredentialRejection(http(status))).toBe(false);
    }
    expect(isCredentialRejection(http(401, "boom", true))).toBe(false);
    expect(isCredentialRejection(new TypeError("fetch failed"))).toBe(false);
    expect(
      isCredentialRejection(new LlamaServerError("nope", 401, "http://l")),
    ).toBe(false);
    expect(
      isCredentialRejection(new SubscriptionCliAuthError("claude", "Run /login.")),
    ).toBe(false);
  });
});

describe("isOutageFailure", () => {
  it("is a link that is not answering: no response, a server error, busy", () => {
    expect(isOutageFailure(http(null))).toBe(true);
    expect(isOutageFailure(http(null, "timed out", true))).toBe(true);
    for (const status of [408, 429, 500, 502, 503]) {
      expect(isOutageFailure(http(status))).toBe(true);
    }
    expect(isOutageFailure(new TypeError("fetch failed"))).toBe(true);
    expect(
      isOutageFailure(new LlamaServerError("fetch failed", null, "http://l")),
    ).toBe(true);
    expect(
      isOutageFailure(Object.assign(new Error("connect"), { code: "ECONNREFUSED" })),
    ).toBe(true);
  });

  it("is a provider asking for a cooldown, whatever the status", () => {
    expect(
      isOutageFailure(
        http(
          402,
          'openai provider 402: {"error":{"code":"in_flight_budget_exhausted"}}',
        ),
      ),
    ).toBe(true);
  });

  it("is not a link that answered no", () => {
    for (const status of [400, 401, 403, 404]) {
      expect(isOutageFailure(http(status))).toBe(false);
    }
    expect(
      isOutageFailure(
        http(402, "openai provider 402: This request requires more credits"),
      ),
    ).toBe(false);
    expect(
      isOutageFailure(new LlamaServerError("not found", 404, "http://l")),
    ).toBe(false);
    expect(
      isOutageFailure(new SubscriptionCliAuthError("claude", "Run /login.")),
    ).toBe(false);
    expect(
      isOutageFailure(new ModelError("empty", "model returned empty content")),
    ).toBe(false);
  });
});
