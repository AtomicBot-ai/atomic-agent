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
  falloverCause,
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

describe("falloverCause", () => {
  it("reads Gemini's per-minute 429 as transient, though it talks quota and billing", () => {
    const gemini = JSON.stringify([
      {
        error: {
          code: 429,
          message:
            "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-2.5-flash\nPlease retry in 41.6s.",
          status: "RESOURCE_EXHAUSTED",
        },
      },
    ]);
    expect(falloverCause(withBody(429, gemini, "gemini"))).toBe("other");
  });

  it("reads OpenAI's insufficient_quota 429 as billing", () => {
    const openai = JSON.stringify({
      error: {
        message:
          "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
        type: "insufficient_quota",
        param: null,
        code: "insufficient_quota",
      },
    });
    expect(falloverCause(withBody(429, openai, "openai"))).toBe("billing");
    expect(falloverCause(withBody(403, OUT_OF_FUNDS))).toBe("billing");
  });

  it("reads a moderation 403 as the request's refusal, a plain 401/403 as the key's", () => {
    const flagged = JSON.stringify({
      error: {
        code: 403,
        message:
          'openai/gpt-4o requires moderation on OpenRouter. Your input was flagged for "harassment"',
        metadata: { reasons: ["harassment"], flagged_input: "...", provider_name: "OpenAI", model_slug: "openai/gpt-4o" },
      },
    });
    expect(falloverCause(withBody(403, flagged, "openrouter"))).toBe("other");
    expect(falloverCause(http(401))).toBe("auth");
    expect(falloverCause(withBody(403, JSON.stringify({ error: { message: "Invalid API key" } })))).toBe("auth");
  });

  it("leaves an empty account's 400 to the text instead of calling it transient", () => {
    const anthropic = JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
    });
    const openai = JSON.stringify({
      error: {
        message: "Billing hard limit has been reached",
        type: "invalid_request_error",
        param: null,
        code: "billing_hard_limit_reached",
      },
    });
    expect(falloverCause(withBody(400, anthropic, "anthropic"))).toBeUndefined();
    expect(falloverCause(withBody(400, openai, "openai"))).toBeUndefined();
  });

  it("is sure only where the error says so", () => {
    expect(falloverCause(http(null))).toBe("other");
    expect(falloverCause(http(503))).toBe("other");
    expect(falloverCause(http(429))).toBe("other");
    expect(falloverCause(http(404))).toBe("other");
    expect(falloverCause(http(400, "x", true))).toBe("other");
    expect(falloverCause(http(422))).toBeUndefined();
  });

  it("does not read an account flagged for abuse, or any 401, as moderation", () => {
    const flaggedAccount = JSON.stringify({
      error: { message: "Your account has been flagged for suspicious activity and suspended." },
    });
    expect(falloverCause(withBody(403, flaggedAccount, "openrouter"))).toBe("auth");
    const flaggedInput = JSON.stringify({
      error: { message: "Your chosen model requires moderation and your input was flagged" },
    });
    expect(falloverCause(withBody(401, flaggedInput, "openrouter"))).toBe("auth");
  });

  it("leaves anything that is not a cloud provider's answer to the text", () => {
    expect(falloverCause(new TypeError("fetch failed"))).toBeUndefined();
    expect(falloverCause(new LlamaServerError("boom", 503, "http://l"))).toBeUndefined();
  });
});

/**
 * ATO-468: the bodies Azure OpenAI and Amazon Bedrock answer with, read
 * the way the chain reads every OpenAI-compatible link. Shapes from the
 * vendors' docs and a live probe of Bedrock Mantle (2026-11-12).
 */
describe("Azure OpenAI and Amazon Bedrock error shapes", () => {
  const AZURE_401 = JSON.stringify({
    error: {
      code: "401",
      message:
        "Access denied due to invalid subscription key or wrong API endpoint. Make sure to provide a valid key for an active subscription and use a correct regional API endpoint for your resource.",
    },
  });
  const AZURE_429 = JSON.stringify({
    error: {
      code: "429",
      message:
        "Requests to the ChatCompletions_Create Operation under Azure OpenAI API version v1 have exceeded token rate limit of your current OpenAI S0 pricing tier. Please retry after 6 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit.",
    },
  });
  const AZURE_404 = JSON.stringify({
    error: {
      code: "DeploymentNotFound",
      message:
        "The API deployment for this resource does not exist. If you created the deployment within the last 5 minutes, please wait a moment and try again.",
    },
  });
  const AZURE_FILTERED = JSON.stringify({
    error: {
      message:
        "The response was filtered due to the prompt triggering Azure OpenAI's content management policy.",
      type: null,
      param: "prompt",
      code: "content_filter",
      status: 400,
    },
  });
  const BEDROCK_401 = JSON.stringify({
    error: {
      code: "invalid_api_key",
      message: "Invalid bearer token",
      param: null,
      type: "permission_denied_error",
    },
  });

  it("reads Azure's 401 as a refused key, not an outage or billing", () => {
    const err = withBody(401, AZURE_401, "azure-openai");
    expect(isCredentialRejection(err)).toBe(true);
    expect(falloverCause(err)).toBe("auth");
    expect(isOutageFailure(err)).toBe(false);
    expect(isBillingRefusal(err)).toBe(false);
  });

  it("reads Azure's token rate limit as a wait, never an empty account", () => {
    const err = withBody(429, AZURE_429, "azure-openai");
    expect(isBillingRefusal(err)).toBe(false);
    expect(isOutageFailure(err)).toBe(true);
    expect(falloverCause(err)).toBe("other");
  });

  it("reads a missing Azure deployment and a content filter as the link's no, not its key", () => {
    const missing = withBody(404, AZURE_404, "azure-openai");
    expect(isCredentialRejection(missing)).toBe(false);
    expect(isOutageFailure(missing)).toBe(false);
    expect(falloverCause(missing)).toBe("other");
    const filtered = withBody(400, AZURE_FILTERED, "azure-openai");
    expect(isCredentialRejection(filtered)).toBe(false);
    expect(isOutageFailure(filtered)).toBe(false);
    expect(isBillingRefusal(filtered)).toBe(false);
  });

  it("reads Bedrock's refused or expired key as a refused key, 401 or 403", () => {
    expect(isCredentialRejection(withBody(401, BEDROCK_401, "bedrock"))).toBe(true);
    for (const message of [
      "Bearer Token has expired",
      "The security token included in the request is invalid.",
    ]) {
      const err = withBody(403, JSON.stringify({ message }), "bedrock");
      expect(isCredentialRejection(err), message).toBe(true);
      expect(isBillingRefusal(err), message).toBe(false);
      expect(isOutageFailure(err), message).toBe(false);
    }
  });

  it("does not blame the key for Bedrock's model-access 403", () => {
    const err = withBody(
      403,
      JSON.stringify({ message: "You don't have access to the model with the specified model ID." }),
      "bedrock",
    );
    expect(isCredentialRejection(err)).toBe(false);
    expect(isBillingRefusal(err)).toBe(false);
    expect(isOutageFailure(err)).toBe(false);
  });

  it("reads Bedrock throttling and unavailability as an outage", () => {
    for (const [status, message] of [
      [429, "Too many tokens, please wait before trying again."],
      [503, "Bedrock is unable to process your request."],
    ] as const) {
      const err = withBody(status, JSON.stringify({ message }), "bedrock");
      expect(isOutageFailure(err), message).toBe(true);
      expect(isBillingRefusal(err), message).toBe(false);
      expect(falloverCause(err), message).toBe("other");
    }
  });
});
