import { describe, expect, it } from "vitest";

import { describeReason } from "../llm/fallback/describe-reason.js";
import { falloverCause } from "../llm/fallback/link-failure-kind.js";
import { OpenAiHttpError } from "../llm/provider/openai/openai-http.js";
import { parseProviderErrorBody } from "../llm/provider/openai/parse-provider-error-body.js";
import {
  classifyFalloverReason,
  formatProviderFalloverNotice,
} from "./format-provider-fallover.js";

/** A provider error as `httpErrorFromResponse` builds it. */
function providerError(status: number, body: string, label: string): OpenAiHttpError {
  return new OpenAiHttpError(
    `openai provider ${status}: ${body}`,
    status,
    "https://example.test/v1/chat/completions",
    false,
    null,
    label,
    undefined,
    { body: parseProviderErrorBody(body) },
  );
}

/** Gemini's OpenAI-compatible 429 for its free tier's per-minute limit. */
const GEMINI_PER_MINUTE_429 = JSON.stringify([
  {
    error: {
      code: 429,
      message:
        "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-2.5-flash\nPlease retry in 41.6s.",
      status: "RESOURCE_EXHAUSTED",
    },
  },
]);

/** OpenAI's 429 for an account with no quota left. */
const OPENAI_INSUFFICIENT_QUOTA_429 = JSON.stringify({
  error: {
    message:
      "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
    type: "insufficient_quota",
    param: null,
    code: "insufficient_quota",
  },
});

/** OpenRouter's 403 for input a moderated model's filter flagged. */
const OPENROUTER_MODERATION_403 = JSON.stringify({
  error: {
    code: 403,
    message:
      'openai/gpt-4o requires moderation on OpenRouter. Your input was flagged for "harassment"',
    metadata: {
      reasons: ["harassment"],
      flagged_input: "...",
      provider_name: "OpenAI",
      model_slug: "openai/gpt-4o",
    },
  },
});

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

  it.each([
    // Gemini (Vertex wording): a quota per minute is a rate limit.
    `openai provider 429: {"error":{"code":429,"message":"Quota exceeded for quota metric 'Generate Content API requests per minute' and limit 'GenerateContent request limit per minute for a region'","status":"RESOURCE_EXHAUSTED"}}`,
    // Gemini's free tier, billing words and all, with its cooldown in view.
    "openai provider 429: You exceeded your current quota, please check your plan and billing details. Please retry in 41.6s.",
    'openai provider 429: {"error":{"message":"Rate limit exceeded: free-models-per-min. ","code":429}}',
    '"gemini" is rate-limiting this key (429). Tried 3 times — wait a minute and retry.',
  ])("reads a rate window in quota or billing words as transient: %j", (reason) => {
    expect(classifyFalloverReason(reason)).toBe("other");
  });

  it("keeps OpenAI's insufficient_quota a billing refusal, rate words or not", () => {
    expect(
      classifyFalloverReason(`openai provider 429: ${OPENAI_INSUFFICIENT_QUOTA_429}`),
    ).toBe("billing");
    expect(
      classifyFalloverReason(
        '"openai" refused the request: you exceeded your current quota, please check your plan and billing details. Top up your balance with "openai" or pick another provider in the Providers panel.',
      ),
    ).toBe("billing");
    expect(
      classifyFalloverReason("openai provider 429: insufficient_quota, see the rate limits page"),
    ).toBe("billing");
  });

  it("does not read a moderation 403 as a key refusal", () => {
    expect(
      classifyFalloverReason(`openai provider 403: ${OPENROUTER_MODERATION_403}`),
    ).toBe("other");
    expect(
      classifyFalloverReason(describeReason(providerError(403, OPENROUTER_MODERATION_403, "openrouter"))),
    ).toBe("other");
  });

  it("still reads a plain 401 or 403 as a key refusal", () => {
    expect(classifyFalloverReason("openai provider 401: ")).toBe("auth");
    expect(classifyFalloverReason("openai provider 403: ")).toBe("auth");
    expect(
      classifyFalloverReason('openai provider 401: {"error":{"message":"Incorrect API key provided: sk-abc***xyz."}}'),
    ).toBe("auth");
  });
});

/* The reason text is the raw body cut to 180 characters, and Gemini's
   per-minute 429 and OpenAI's insufficient_quota 429 open with the same
   sentence: the part that tells them apart is past the cut. The cause the
   runtime reads off the whole error is what the notice must go by. */
describe("the fallover notice for the errors the chain actually sees", () => {
  const notice = (err: OpenAiHttpError): string =>
    formatProviderFalloverNotice("gemini", "local-llama", describeReason(err), falloverCause(err));

  it("does not tell the operator to top up for Gemini's per-minute limit", () => {
    const err = providerError(429, GEMINI_PER_MINUTE_429, "gemini");
    // The text alone cannot tell: this is the misreading the cause fixes.
    expect(classifyFalloverReason(describeReason(err))).toBe("billing");
    expect(falloverCause(err)).toBe("other");
    const text = notice(err);
    expect(text).not.toMatch(/top it up|will not clear by itself/);
    expect(text).toContain("until gemini recovers");
  });

  it("still tells the operator to top up for OpenAI's insufficient_quota", () => {
    const err = providerError(429, OPENAI_INSUFFICIENT_QUOTA_429, "openai");
    expect(falloverCause(err)).toBe("billing");
    expect(notice(err)).toMatch(/top it up/);
  });

  it("does not send the operator to the key for a moderation 403", () => {
    const err = providerError(403, OPENROUTER_MODERATION_403, "openrouter");
    expect(falloverCause(err)).toBe("other");
    const text = notice(err);
    expect(text).not.toContain(".env");
    expect(text).not.toMatch(/refused the credentials/);
  });

  it("still sends the operator to the key for a plain 401 or 403", () => {
    for (const status of [401, 403]) {
      const err = providerError(status, "", "openrouter");
      expect(falloverCause(err)).toBe("auth");
      expect(notice(err)).toContain(".env");
    }
  });

  it("falls back to the text for an error the runtime cannot read", () => {
    expect(falloverCause(new Error("socket hang up"))).toBeUndefined();
    expect(
      formatProviderFalloverNotice("openrouter", "local-llama", '"openrouter" rejected the request (402).', undefined),
    ).toMatch(/top it up/);
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
