import { describe, expect, it, vi } from "vitest";

import { OpenAiHttpError, humanizeOpenAiHttpError, openAiPostJson, type OpenAiHttpDeps } from "./openai-http.js";
import { isGroqRequestTooLarge } from "./groq-plan-limit.js";
import { TransportError } from "../../reliability/llm-failures.js";
import { isExpectedProviderLimit } from "../../reliability/expected-provider-limit.js";

/** Groq's 413 for a request over the free tier's tokens per minute (ATO-1283). */
const GROQ_413_BODY = JSON.stringify({
  error: {
    message:
      "Request too large for model `llama-3.3-70b-versatile` in organization `org_01abc` service tier `on_demand` " +
      "on tokens per minute (TPM): Limit 12000, Requested 15639, please reduce your message size and try again. " +
      "Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing",
    type: "tokens",
    code: "rate_limit_exceeded",
  },
});

function deps(fetchImpl: typeof fetch, baseUrl = "https://api.groq.com/openai", label = "groq"): OpenAiHttpDeps {
  return { baseUrl, apiKey: "key", extraHeaders: {}, requestTimeoutMs: 60_000, fetchImpl, label };
}

async function failWith(status: number, body: string, baseUrl?: string, label?: string): Promise<OpenAiHttpError> {
  const fetchImpl = vi.fn(async () => new Response(body, { status, headers: { "content-type": "application/json" } }));
  const err = await openAiPostJson(deps(fetchImpl as unknown as typeof fetch, baseUrl, label), "/v1/chat/completions", {}, {})
    .then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(OpenAiHttpError);
  // A plan limit answers the same on every retry: one request only.
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  return err as OpenAiHttpError;
}

describe("Groq 413 over the free tier limit (ATO-1283)", () => {
  it("tells the user which limit it is and what helps, with Groq's numbers", async () => {
    const err = await failWith(413, GROQ_413_BODY);
    expect(isGroqRequestTooLarge(err)).toBe(true);
    const said = humanizeOpenAiHttpError(err);
    expect(said).toContain("larger than the Groq free tier limit");
    expect(said).toContain("limit 12000 tokens per minute, this request 15639");
    expect(said).toContain("Pick a model with a higher limit or upgrade the Groq plan.");
    expect(said).toContain("(413)");
    expect(said).not.toContain("org_01abc");
  });

  it("still explains a Groq 413 whose body names no numbers", async () => {
    const err = await failWith(413, "Request Entity Too Large");
    const said = humanizeOpenAiHttpError(err);
    expect(said).toContain("larger than the Groq free tier limit.");
    expect(said).not.toContain("limit 12000");
  });

  it("knows a second Groq entry by its id when the host is a proxy", async () => {
    const err = await failWith(413, GROQ_413_BODY, "https://proxy.example.com", "groq-2");
    expect(isGroqRequestTooLarge(err)).toBe(true);
  });

  it("leaves other providers' 413 and Groq's other statuses alone", async () => {
    const other = await failWith(413, "payload too large", "https://api.example.com", "testprov");
    expect(isGroqRequestTooLarge(other)).toBe(false);
    expect(humanizeOpenAiHttpError(other)).not.toContain("Groq");
    const groq400 = await failWith(400, JSON.stringify({ error: { message: "bad tool" } }));
    expect(isGroqRequestTooLarge(groq400)).toBe(false);
  });

  it("is an expected provider limit through the step's TransportError, so it is not reported", async () => {
    const err = await failWith(413, GROQ_413_BODY);
    const wrapped = new TransportError(humanizeOpenAiHttpError(err), 413, err.url, { cause: err });
    expect(isExpectedProviderLimit(wrapped)).toBe(true);
    expect(isExpectedProviderLimit(err)).toBe(true);
    const other = await failWith(413, "payload too large", "https://api.example.com", "testprov");
    expect(isExpectedProviderLimit(new TransportError("x", 413, other.url, { cause: other }))).toBe(false);
    expect(isExpectedProviderLimit(new Error("synthetic"))).toBe(false);
    expect(isExpectedProviderLimit("not an error")).toBe(false);
  });
});
