import { describe, expect, it } from "vitest";

import {
  classifyUpstreamReason,
  extractUpstreamErrorDetail,
  extractUpstreamParam,
  normalizeParamPath,
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
    ["model id", "The model `gpt-9` does not exist or you do not have access to it.", "model_not_found"],
    ["nothing known", "Something odd happened.", "other"],
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

describe("extractUpstreamParam (ATO-1673)", () => {
  it("prefers OpenAI's declared param, indices reduced", () => {
    const text =
      '{"error":{"message":"Invalid \'messages[2].content\': string too long.","type":"invalid_request_error","param":"messages[2].content","code":"string_above_max_length"}}';
    expect(extractUpstreamParam(text)).toBe("messages[].content");
  });

  it("reads Anthropic's dotted path at the head of the message", () => {
    expect(
      extractUpstreamParam("messages.3.content.0.text: text content blocks must be non-empty"),
    ).toBe("messages[].content[].text");
  });

  it("reads Gemini's request path", () => {
    expect(
      extractUpstreamParam(
        "* GenerateContentRequest.contents[3].parts[0].function_call: missing thought_signature",
      ),
    ).toBe("GenerateContentRequest.contents[].parts[].function_call");
  });

  it("drops everything below a schema's properties: tool argument names stay home", () => {
    const param = extractUpstreamParam(
      "Invalid value at 'tools[0].function.parameters.properties.my_secret_field': draft my resignation letter",
    );
    expect(param).toBe("tools[].function.parameters.properties.*");
  });

  it("does not read a scalar root out of prose (a file name is not a field)", () => {
    expect(extractUpstreamParam("failed to load model.Q4_K_M from disk")).toBeUndefined();
  });

  it("does not read a bare container word out of prose", () => {
    expect(extractUpstreamParam("too many messages in the request")).toBeUndefined();
  });

  it("keeps a declared one-word scalar param", () => {
    expect(extractUpstreamParam('{"error":{"param":"temperature"}}')).toBe("temperature");
  });
});

describe("normalizeParamPath", () => {
  it("refuses a path that does not start at a known request field", () => {
    expect(normalizeParamPath("draft.my.letter")).toBeUndefined();
  });

  it("refuses a link that is not an identifier", () => {
    expect(normalizeParamPath("messages[1].content with spaces")).toBeUndefined();
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
