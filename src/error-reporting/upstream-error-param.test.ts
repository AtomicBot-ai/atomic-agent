import { describe, expect, it } from "vitest";

import {
  extractUpstreamParam,
  normalizeParamPath,
} from "./upstream-error-detail.js";

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
