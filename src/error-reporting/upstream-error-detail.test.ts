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
    [
      "Anthropic trailing whitespace",
      "messages: final assistant content cannot end with trailing whitespace",
      "trailing_whitespace",
    ],
    ["a bare prefill mention", "The prefill was ignored.", "other"],
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

  it.each([
    ["a tool name", "Invalid value: 'tools.acme_payroll_sync' is not allowed", "tools.*"],
    [
      "a dependentSchemas key",
      "tools[0].function.parameters.dependentSchemas.secret_arg: unsupported",
      "tools[].function.parameters.dependentSchemas.*",
    ],
    [
      "a $defs-like definitions key",
      "tools[0].function.parameters.definitions.CustomerRecord: bad ref",
      "tools[].function.parameters.definitions.*",
    ],
    [
      "a dependentRequired key",
      "tools[1].function.parameters.dependentRequired.ssn: invalid",
      "tools[].function.parameters.dependentRequired.*",
    ],
    [
      "a dependencies key",
      "tools[1].function.parameters.dependencies.salary: invalid",
      "tools[].function.parameters.dependencies.*",
    ],
    [
      "a patternProperties key",
      "tools[0].function.parameters.patternProperties.acct_x: invalid",
      "tools[].function.parameters.patternProperties.*",
    ],
    ["a user-named message field", "Unknown field messages.private_notes", "messages.*"],
    [
      "a Gemini function_call argument",
      "* GenerateContentRequest.contents[2].parts[0].function_call.args.patient_name: bad",
      "GenerateContentRequest.contents[].parts[].function_call.args.*",
    ],
    [
      "a Gemini function_response key",
      "contents[4].parts[0].function_response.response.diagnosis: invalid",
      "contents[].parts[].function_response.response.*",
    ],
    [
      "an Anthropic tool_use input key",
      "messages.1.content.0.input.bank_account: invalid",
      "messages[].content[].input.*",
    ],
    [
      "an OpenAI tool call arguments key",
      "messages[3].tool_calls[0].function.arguments.home_address: invalid",
      "messages[].tool_calls[].function.arguments.*",
    ],
  ])("keeps no chosen name below the root: %s", (_label, text, expected) => {
    const param = extractUpstreamParam(text);
    expect(param).toBe(expected);
    for (const secret of [
      "acme_payroll_sync", "secret_arg", "CustomerRecord", "ssn", "salary",
      "acct_x", "private_notes", "patient_name", "diagnosis",
      "bank_account", "home_address",
    ]) {
      expect(param).not.toContain(secret);
    }
  });

  it.each([
    ["a POSIX path", "could not read /Users/n/Documents/contents.txt"],
    ["a Windows path", "could not read C:\\notes\\messages.md"],
    ["a home path", "see ~/tools.json"],
    ["a file name in prose", "uploaded file contents.pdf was rejected"],
  ])("does not read a file name as a field: %s", (_label, text) => {
    expect(extractUpstreamParam(text)).toBeUndefined();
  });

  it("keeps a declared one-word scalar param", () => {
    expect(extractUpstreamParam('{"error":{"param":"temperature"}}')).toBe("temperature");
  });
});

describe("normalizeParamPath", () => {
  it("refuses a path that does not start at a known request field", () => {
    expect(normalizeParamPath("draft.my.letter")).toBeUndefined();
  });

  it("cuts at a link that is not an identifier", () => {
    expect(normalizeParamPath("messages[1].content with spaces")).toBe("messages[].*");
  });

  it("cuts a named bracket to *", () => {
    expect(
      normalizeParamPath("tools[0].function_declarations[2].parameters[secret_arg]"),
    ).toBe("tools[].function_declarations[].parameters.*");
  });

  it("cuts a declared param at the first chosen name too", () => {
    expect(normalizeParamPath("tools[0].function.acme_payroll_sync")).toBe(
      "tools[].function.*",
    );
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
