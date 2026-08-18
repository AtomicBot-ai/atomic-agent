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

  it("merges extraBody vendor fields into the request body", () => {
    const body = buildOpenAiChatBody({ prompt: "hi" }, "qwen3.8-27b", false, {
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.model).toBe("qwen3.8-27b");
  });

  it("keeps the body byte-identical when extraBody is absent", () => {
    const withoutArg = buildOpenAiChatBody({ prompt: "hi" }, "qwen3.8-27b", false);
    const withUndefined = buildOpenAiChatBody(
      { prompt: "hi" },
      "qwen3.8-27b",
      false,
      undefined,
    );
    expect(JSON.stringify(withUndefined)).toBe(JSON.stringify(withoutArg));
  });

  it("does not let extraBody override reserved keys", () => {
    const body = buildOpenAiChatBody(
      {
        prompt: "hi",
        tools: [
          {
            type: "function",
            function: { name: "search", parameters: { type: "object" } },
          },
        ],
      },
      "qwen3.8-27b",
      true,
      {
        model: "attacker-model",
        messages: [{ role: "user", content: "overwritten" }],
        stream: false,
        tools: [],
      },
    );
    expect(body.model).toBe("qwen3.8-27b");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.stream).toBe(true);
    expect(body.tools).toHaveLength(1);
  });

  it("drops a reserved key that the builder itself never set", () => {
    // `tools` is absent when the caller sends no tools; extraBody must not
    // be able to smuggle a tool contract in through the passthrough.
    const body = buildOpenAiChatBody({ prompt: "hi" }, "qwen3.8-27b", false, {
      tools: [
        {
          type: "function",
          function: { name: "shell", parameters: { type: "object" } },
        },
      ],
    });
    expect(body.tools).toBeUndefined();
    expect("tools" in body).toBe(false);
  });
});
