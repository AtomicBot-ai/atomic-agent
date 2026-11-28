import { describe, expect, it } from "vitest";

import {
  classifyUpstreamReason,
  extractUpstreamErrorDetail,
} from "./upstream-error-detail.js";

/** The `TransportError` → `OpenAiHttpError` chain the runtime reports. */
function providerFailure(status: number, body: Record<string, unknown>): Error {
  const cause = Object.assign(new Error(`openai provider ${status}: …`), {
    name: "OpenAiHttpError",
    status,
    body,
  });
  return Object.assign(new Error("humanized"), {
    name: "TransportError",
    status,
    cause,
  });
}

describe("classifyUpstreamReason (ATO-1673)", () => {
  it.each([
    [
      "Gemini 3 thought signature",
      '[{"error":{"code":400,"message":"Function call is missing a thought_signature in functionCall parts.","status":"INVALID_ARGUMENT"}}]',
      "missing_thought_signature",
    ],
    [
      "DeepSeek thinking mode",
      "Missing `reasoning_content` field in the assistant message at message index 4",
      "missing_reasoning_content",
    ],
    [
      "Anthropic tool_use without result",
      "messages.5: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01",
      "tool_result_missing",
    ],
    [
      "OpenAI tool_calls without tool messages",
      "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'.",
      "tool_result_missing",
    ],
    [
      "Anthropic orphan tool_result",
      "messages.2.content.0: unexpected `tool_use_id` found in `tool_result` blocks",
      "tool_result_orphan",
    ],
    [
      "Anthropic empty text block",
      "messages.3.content.0.text: text content blocks must be non-empty",
      "empty_content",
    ],
    [
      "Anthropic prefill",
      "This model does not support assistant message prefill. The conversation must end with a user message.",
      "must_end_with_user",
    ],
    [
      "llama.cpp context",
      "request (14612 tokens) exceeds the available context size (12800 tokens)",
      "context_overflow",
    ],
    [
      "Gemini schema keyword",
      'Invalid JSON payload received. Unknown name "$defs" at \'tools[0].function_declarations[2].parameters\'',
      "tool_schema_invalid",
    ],
    [
      "unsupported parameter",
      "Unsupported parameter: 'parallel_tool_calls' is not supported with this model.",
      "unsupported_parameter",
    ],
    [
      "Anthropic trailing whitespace",
      "messages: final assistant content cannot end with trailing whitespace",
      "trailing_whitespace",
    ],
    ["a bare prefill mention", "The prefill was ignored.", "other"],
    ["model id", "The model `gpt-9` does not exist or you do not have access to it.", "model_not_found"],
    ["nothing known", "Something odd happened.", "other"],
    // ATO-2419: a refused key, whatever status it came with.
    [
      "Gemini key on a 400",
      '[{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}]',
      "key_refused",
    ],
    [
      "Anthropic key",
      '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      "key_refused",
    ],
    ["OpenAI key", "Incorrect API key provided: sk-abc***. You can find your API key in your account.", "key_refused"],
    ["DeepSeek key", "Authentication Fails, Your api key: ****abcd is invalid", "key_refused"],
    ["OpenRouter no key", "No auth credentials found", "key_refused"],
    // ATO-1673: vendor words seen on 0.9.0 refusals.
    [
      "new-api empty balance",
      '{"error":{"code":"insufficient_user_quota","message":"user quota is not enough","type":"new_api_error"}}',
      "out_of_credit",
    ],
    [
      "DeepSeek balance type",
      '{"error":{"message":"Not enough","type":"insufficient_balance_error"}}',
      "out_of_credit",
    ],
    [
      "account not activated",
      '{"error":{"code":"activation_required","message":"Please activate your account first"}}',
      "key_refused",
    ],
    [
      "OpenRouter no tool endpoint",
      '{"error":{"message":"No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs","code":404}}',
      "tools_unsupported",
    ],
    ["model cannot use tools", "This model cannot use tools.", "tools_unsupported"],
  ])("%s", (_label, text, expected) => {
    expect(classifyUpstreamReason(text)).toBe(expected);
  });

  it("reads any 402 as out of credit, even with no body text", () => {
    expect(classifyUpstreamReason("", 402)).toBe("out_of_credit");
  });

  it("names no reason when there is no text to read", () => {
    expect(classifyUpstreamReason("  ")).toBeNull();
  });
});

describe("extractUpstreamErrorDetail (ATO-1673)", () => {
  it("walks from the wrapper to the provider body and keeps only fixed words", () => {
    const err = providerFailure(400, {
      type: "invalid_request_error",
      code: "invalid_value",
      message: "messages.3.content.0.text: text content blocks must be non-empty",
      text: '{"error":{"message":"messages.3.content.0.text: text content blocks must be non-empty, user said: draft my resignation letter"}}',
    });
    const detail = extractUpstreamErrorDetail(err);
    expect(detail).toEqual({
      upstreamReason: "empty_content",
      upstreamErrorParam: "messages[].content[].text",
      upstreamErrorCode: "invalid_value",
    });
    expect(JSON.stringify(detail)).not.toContain("resignation");
  });

  it("tags a 402 as out of credit so it can be told from a 400", () => {
    const err = providerFailure(402, { type: "invalid_request_error", text: "" });
    expect(extractUpstreamErrorDetail(err).upstreamReason).toBe("out_of_credit");
  });

  it("takes Google's error.status as the code when error.code is a number", () => {
    const err = providerFailure(400, {
      code: "400",
      status: "INVALID_ARGUMENT",
      text: "x",
    });
    expect(extractUpstreamErrorDetail(err).upstreamErrorCode).toBe("INVALID_ARGUMENT");
  });

  it("drops a freeform code", () => {
    const err = providerFailure(400, { code: "draft my letter", text: "x" });
    expect(extractUpstreamErrorDetail(err).upstreamErrorCode).toBeUndefined();
  });

  it("is empty when nothing on the chain carries a body", () => {
    expect(extractUpstreamErrorDetail(new Error("boom"))).toEqual({});
  });

  it("names no reason for a body that kept only its type", () => {
    const err = providerFailure(400, { type: "exceed_context_size_error" });
    expect(extractUpstreamErrorDetail(err).upstreamReason).toBeUndefined();
  });
});
