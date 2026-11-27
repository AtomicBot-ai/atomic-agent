import { describe, expect, it, vi } from "vitest";

import { parseProviderErrorBody } from "../llm/provider/openai/parse-provider-error-body.js";
import { captureError } from "./error-reporter.js";
import { scrubError, type ScrubbedErrorEvent } from "./error-scrubber.js";
import { isPersonRefusal } from "./person-refusal.js";
import type { SentryClient } from "./sentry-client.js";

function fakeClient() {
  const captured: ScrubbedErrorEvent[] = [];
  const client = {
    capture: vi.fn((ev: ScrubbedErrorEvent) => captured.push(ev)),
  } as unknown as SentryClient;
  return { client, captured };
}

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

/** The `TransportError` → `OpenAiHttpError` chain the runtime reports. */
function refusal(status: number, raw: string, url = OPENROUTER): Error {
  const cause = Object.assign(new Error(`openai provider ${status}: ${raw.slice(0, 300)}`), {
    name: "OpenAiHttpError",
    status,
    url,
    body: parseProviderErrorBody(raw),
  });
  return Object.assign(new Error("humanized"), { name: "TransportError", status, url, cause });
}

const transport = { source: "llm_failure", category: "transport" } as const;

/** How many of `errors` reach Sentry through `captureError`. */
function reported(...errors: Error[]): number {
  const { client, captured } = fakeClient();
  for (const err of errors) captureError(client, err, transport);
  return captured.length;
}

describe("captureError leaves the person's own refusals out (ATO-1673)", () => {
  it.each([
    ["OpenRouter out of credit", 402, '{"error":{"message":"This request requires more credits, or fewer max_tokens.","code":402}}'],
    ["DeepSeek balance", 402, '{"error":{"message":"Insufficient Balance","type":"insufficient_balance_error"}}'],
    ["new-api empty balance", 403, '{"error":{"code":"insufficient_user_quota","message":"user quota is not enough","type":"new_api_error"}}'],
    ["refused key", 401, '{"error":{"type":"authentication_error","code":"activation_required","message":"activate first"}}'],
    ["rate limit", 429, '{"error":{"message":"Rate limit exceeded","code":"rate_limit_exceeded"}}'],
    ["plan per-minute allowance", 429, '{"error":{"message":"Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 163395."}}'],
    ["model id", 404, '{"error":{"message":"The model `gpt-9` does not exist","type":"not_found_error"}}'],
    ["cloud model without tools", 400, '{"error":{"message":"This model does not support tools."}}'],
    ["OpenRouter no tool endpoint", 404, '{"error":{"message":"No endpoints found that support tool use.","code":404}}'],
  ] as const)("%s", (_label, status, raw) => {
    expect(reported(refusal(status, raw))).toBe(0);
  });

  it("leaves out a model Ollama does not have, a server the person runs", () => {
    const raw = '{"error":{"message":"model \\"qwen3:8b\\" not found, try pulling it first"}}';
    expect(reported(refusal(404, raw, "http://127.0.0.1:11434/v1/chat/completions"))).toBe(0);
  });
});

describe("captureError still reports what may be ours (ATO-1673)", () => {
  it("a request we built wrong, a provider's trouble and an unknown 400", () => {
    expect(
      reported(
        refusal(400, '{"error":{"message":"messages.5: `tool_use` ids were found without `tool_result` blocks immediately after"}}'),
        refusal(503, '{"error":{"message":"Service Unavailable"}}'),
        refusal(400, '{"error":{"message":"Something odd happened."}}'),
      ),
    ).toBe(3);
  });

  it("a 413 and a request too large on a 400: the prompt may be too big (ATO-1283)", () => {
    expect(
      reported(
        refusal(413, '{"error":{"message":"Payload Too Large"}}'),
        refusal(400, '{"error":{"message":"Request too large for this model."}}'),
      ),
    ).toBe(2);
  });

  it("a 401 from the managed engine on this machine (lane S1's)", () => {
    expect(reported(refusal(401, '{"error":{"message":"Invalid API Key"}}', "http://127.0.0.1:9931/v1/chat/completions"))).toBe(1);
  });

  it("a 404 or a server without tools on the managed engine's port", () => {
    const managed = "http://127.0.0.1:9931/v1/chat/completions";
    expect(
      reported(
        refusal(404, '{"error":{"code":404,"message":"File Not Found","type":"not_found_error"}}', managed),
        refusal(400, '{"error":{"message":"tools param requires --jinja flag"}}', managed),
      ),
    ).toBe(2);
  });

  it("a person refusal reported from anywhere but a turn failure, or as a tool's", () => {
    const { client, captured } = fakeClient();
    const credit = refusal(402, '{"error":{"message":"Insufficient Balance"}}');
    captureError(client, credit, { source: "unhandledRejection" });
    captureError(client, credit, { source: "llm_failure", category: "tool" });
    expect(captured).toHaveLength(2);
  });
});

describe("isPersonRefusal", () => {
  it("reads the scrubbed owner tag, so filter and tag agree", () => {
    const credit = refusal(402, '{"error":{"message":"Insufficient Balance"}}');
    const event = scrubError(credit, transport);
    expect(event.failureOwner).toBe("person");
    expect(isPersonRefusal(credit, event)).toBe(true);
    expect(isPersonRefusal(credit, { ...event, failureOwner: "unknown" })).toBe(false);
  });
});
