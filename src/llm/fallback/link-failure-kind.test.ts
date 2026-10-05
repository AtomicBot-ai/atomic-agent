import { describe, expect, it } from "vitest";

import { LlamaServerError } from "../llama-server-client.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import {
  SubscriptionCliAuthError,
  SubscriptionCliNotInstalledError,
} from "../provider/subscription-cli/subscription-cli-errors.js";
import { ModelError, TransportError } from "../reliability/llm-failures.js";
import { parseProviderErrorBody } from "../provider/openai/parse-provider-error-body.js";
import {
  isBillingRefusal,
  isCliSetupRefusal,
  isCredentialRejection,
  isOutageFailure,
} from "./link-failure-kind.js";

function http(
  status: number | null,
  message = "boom",
  timedOut = false,
): OpenAiHttpError {
  return new OpenAiHttpError(message, status, "http://x/y", timedOut, null, "p");
}

/** A provider error as `httpErrorFromResponse` builds it: the body parsed beside the message. */
function withBody(status: number, body: string, label = "aimlapi"): OpenAiHttpError {
  return new OpenAiHttpError(
    `openai provider ${status}: ${body}`,
    status,
    "https://api.aimlapi.com/v1/chat/completions",
    false,
    null,
    label,
    undefined,
    { body: parseProviderErrorBody(body) },
  );
}

/** Item 40's field body: AI/ML API with a good key and an empty account. */
const OUT_OF_FUNDS = JSON.stringify({
  title: "Forbidden",
  status: 403,
  message:
    "You've run out of funds. Please top up your balance or update your payment method to continue: https://aimlapi.com/app/billing",
});

describe("isBillingRefusal", () => {
  it("is AI/ML API's 403 for an empty account, a 402, and OpenAI's insufficient_quota", () => {
    expect(isBillingRefusal(withBody(403, OUT_OF_FUNDS))).toBe(true);
    expect(isBillingRefusal(withBody(402, '{"error":{"message":"Insufficient Balance"}}'))).toBe(true);
    expect(isBillingRefusal(http(402))).toBe(true);
    expect(
      isBillingRefusal(
        withBody(429, '{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}', "openai"),
      ),
    ).toBe(true);
  });

  it("is not a 429 in a rate limit's words, nor a 403 about authentication that mentions billing", () => {
    for (const message of [
      "Too many requests. Please top up your account to increase your rate limits.",
      "Out of credits for this minute",
    ]) {
      const limited = withBody(429, JSON.stringify({ error: { message } }));
      expect(isBillingRefusal(limited), message).toBe(false);
      expect(isOutageFailure(limited), message).toBe(true);
    }
    for (const message of [
      "Authentication failed. Please check your billing details.",
      "Invalid token. Check billing.",
    ]) {
      const refused = withBody(403, JSON.stringify({ error: { message } }));
      expect(isBillingRefusal(refused), message).toBe(false);
      expect(isCredentialRejection(refused), message).toBe(true);
    }
  });

  it("is not a refused key, a rate limit, a cooldown or an outage", () => {
    expect(isBillingRefusal(withBody(403, '{"error":{"message":"Invalid API key"}}'))).toBe(false);
    expect(isBillingRefusal(http(401))).toBe(false);
    expect(isBillingRefusal(http(429))).toBe(false);
    expect(
      isBillingRefusal(http(402, 'openai provider 402: {"error":{"code":"in_flight_budget_exhausted"}}')),
    ).toBe(false);
    expect(isBillingRefusal(http(null))).toBe(false);
    expect(isBillingRefusal(http(402, "boom", true))).toBe(false);
    expect(isBillingRefusal(new TypeError("fetch failed"))).toBe(false);
    expect(isBillingRefusal(new LlamaServerError("nope", 402, "http://l"))).toBe(false);
  });
});

describe("isCredentialRejection", () => {
  it("is not a 403 about the account's funds, whatever else it mentions", () => {
    expect(isCredentialRejection(withBody(403, OUT_OF_FUNDS))).toBe(false);
    expect(
      isCredentialRejection(
        withBody(403, '{"error":{"message":"Your API key has insufficient balance"}}'),
      ),
    ).toBe(false);
  });

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
    // An empty account, even on a 429 (item 40).
    expect(isOutageFailure(withBody(403, OUT_OF_FUNDS))).toBe(false);
    expect(
      isOutageFailure(
        withBody(429, '{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}', "openai"),
      ),
    ).toBe(false);
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

describe("isCliSetupRefusal", () => {
  it("is a CLI that is not installed or signed out, wrapped or not", () => {
    const missing = new SubscriptionCliNotInstalledError("claude", "x");
    expect(isCliSetupRefusal(missing)).toBe(true);
    expect(isCliSetupRefusal(new SubscriptionCliAuthError("claude", "x"))).toBe(
      true,
    );
    const wrapped = new TransportError(missing.message, null, "", {
      cause: missing,
    });
    expect(isCliSetupRefusal(wrapped)).toBe(true);
    // A status-less TransportError otherwise reads as "no answer at
    // all"; this one is the link saying no (ATO-117).
    expect(isOutageFailure(wrapped)).toBe(false);
  });

  it("is not an outage or a cloud refusal", () => {
    expect(isCliSetupRefusal(new TypeError("fetch failed"))).toBe(false);
    expect(isCliSetupRefusal(http(401))).toBe(false);
  });
});
