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

  it("asks for the usage block on a streamed request, and only there", () => {
    // A streamed reply cut off by `finish_reason: "length"` arrives with
    // no token counts unless the request asks; the counts are what tell
    // a spent reply cap apart from a full context window.
    const streamed = buildOpenAiChatBody({ prompt: "hi" }, "m", true);
    expect(streamed.stream_options).toEqual({ include_usage: true });
    const unary = buildOpenAiChatBody({ prompt: "hi" }, "m", false);
    expect(unary).not.toHaveProperty("stream_options");
  });

  it("lets extraBody drop stream_options for a vendor that rejects it", () => {
    const body = buildOpenAiChatBody({ prompt: "hi" }, "m", true, {
      stream_options: undefined,
    });
    expect(body.stream_options).toBeUndefined();
    expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty("stream_options");
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

  it("serializes parallel_tool_calls: false when the executor asks for a single call (issue #104)", () => {
    // `maxParallelToolCalls=1` (or a provider that cannot emit parallel
    // calls) must reach the wire so the flag acts as a
    // provider-compatibility control, not just an executor cap.
    const body = buildOpenAiChatBody(
      {
        prompt: "hi",
        tools: [{ type: "function", function: { name: "read" } }],
        parallelToolCalls: false,
      },
      "gpt-5-2",
      false,
    );
    expect(body.parallel_tool_calls).toBe(false);
  });

  it("does not attach parallel_tool_calls to a request without tools", () => {
    const body = buildOpenAiChatBody(
      { prompt: "hi", parallelToolCalls: false },
      "gpt-5-2",
      false,
    );
    expect("parallel_tool_calls" in body).toBe(false);
  });
});

describe("buildOpenAiChatBody — the output bound", () => {
  const request = { prompt: "hi", sessionId: "s-1" };

  it("sends no max_tokens when nobody asked for one", () => {
    const body = buildOpenAiChatBody(request, "gpt-test", false);
    // The cap used to default to `localModels.completionMaxTokens` (8192),
    // a llama-server decode budget that has nothing to do with a cloud
    // model — and it killed any turn whose reply ran long, mid-JSON,
    // with "model response truncated at 8192 tokens".
    expect("max_tokens" in body).toBe(false);
  });

  it("honours a cap the caller set", () => {
    const body = buildOpenAiChatBody({ ...request, maxTokens: 512 }, "gpt-test", false);
    expect(body.max_tokens).toBe(512);
  });

  it("lets a provider entry pin one through extraBody", () => {
    const body = buildOpenAiChatBody(request, "gpt-test", false, { max_tokens: 64_000 });
    expect(body.max_tokens).toBe(64_000);
  });

  it("still lets the caller's cap lose to an explicit passthrough", () => {
    // `max_tokens` is deliberately not reserved: an operator who pins a
    // ceiling for a provider that requires one gets the last word.
    const body = buildOpenAiChatBody({ ...request, maxTokens: 512 }, "gpt-test", false, {
      max_tokens: 4096,
    });
    expect(body.max_tokens).toBe(4096);
  });

  it("keeps the fields the caller owns unconditionally", () => {
    const body = buildOpenAiChatBody(request, "gpt-test", true, { model: "hijack" });
    expect(body.model).toBe("gpt-test");
    expect(body.stream).toBe(true);
  });
});

describe("buildOpenAiChatBody — the provider's own ceiling", () => {
  const request = { prompt: "hi" };

  it("applies a configured ceiling when the call names none", () => {
    const body = buildOpenAiChatBody(request, "gpt-test", false, undefined, 64_000);
    expect(body.max_tokens).toBe(64_000);
  });

  it("lets the call's own cap win over the provider's", () => {
    const body = buildOpenAiChatBody(
      { ...request, maxTokens: 512 },
      "gpt-test",
      false,
      undefined,
      64_000,
    );
    expect(body.max_tokens).toBe(512);
  });

  it("sends nothing when neither names one", () => {
    expect("max_tokens" in buildOpenAiChatBody(request, "gpt-test", false)).toBe(false);
  });
});
