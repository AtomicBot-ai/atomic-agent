import { describe, expect, it } from "vitest";

import { buildOpenAiChatBody } from "./openai-build-body.js";

describe("buildOpenAiChatBody", () => {
  it("forwards responseFormat as response_format with type=json_schema and strict=true by default", () => {
    const body = buildOpenAiChatBody(
      {
        prompt: "hi",
        responseFormat: {
          name: "link_generator",
          description: "memory link triples",
          schema: {
            type: "object",
            properties: { kind: { type: "string", enum: ["none"] } },
            required: ["kind"],
            additionalProperties: false,
          },
        },
      },
      "gpt-5-2",
      false,
    );
    expect(body).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "link_generator",
          description: "memory link triples",
          strict: true,
          schema: {
            type: "object",
            properties: { kind: { type: "string", enum: ["none"] } },
            required: ["kind"],
            additionalProperties: false,
          },
        },
      },
    });
  });

  it("honours explicit strict=false override", () => {
    const body = buildOpenAiChatBody(
      {
        prompt: "hi",
        responseFormat: {
          name: "loose",
          schema: { type: "object", properties: {} },
          strict: false,
        },
      },
      "gpt-5-2",
      false,
    );
    expect(body.response_format).toMatchObject({
      json_schema: { strict: false },
    });
  });

  it("does NOT attach response_format when tools is non-empty (vendors reject the combination)", () => {
    // Mixing native function-calling with Structured Outputs is
    // unsupported by Azure and silently degraded by OpenRouter — the
    // function's own `parameters` schema is already the JSON
    // contract, so the runtime never sends both.
    const body = buildOpenAiChatBody(
      {
        prompt: "hi",
        tools: [{ type: "function", function: { name: "reply" } }],
        responseFormat: {
          name: "ignored",
          schema: { type: "object" },
        },
      },
      "gpt-5-2",
      false,
    );
    expect(body.response_format).toBeUndefined();
    expect(body.tools).toBeDefined();
  });

  it("omits response_format entirely when not provided", () => {
    const body = buildOpenAiChatBody(
      { prompt: "hi" },
      "gpt-5-2",
      false,
    );
    expect(body.response_format).toBeUndefined();
  });
});
