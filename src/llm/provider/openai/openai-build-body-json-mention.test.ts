import { describe, expect, it } from "vitest";

import type { ResponseFormatJsonSchema } from "../completion-types.js";
import { JSON_RESPONSE_INSTRUCTION } from "./ensure-json-mention.js";
import { buildOpenAiChatBody } from "./openai-build-body.js";

const format: ResponseFormatJsonSchema = {
  name: "query_rewriter_v1",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { rewritten_query: { type: "string" } },
    required: ["rewritten_query"],
  },
};

const tools = [
  {
    type: "function",
    function: {
      name: "reply",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  },
];

function sentPrompt(body: Record<string, unknown>): string {
  const messages = body.messages as ReadonlyArray<{ content: string }>;
  return messages[0]!.content;
}

describe("buildOpenAiChatBody — the word json", () => {
  // Alibaba-served Qwen answers 400 to any `response_format` request
  // whose messages never say "json"; the sub-call prompts never did.
  it.each([false, true])(
    "appends the JSON instruction when response_format goes out and the prompt never says json (stream=%s)",
    (stream) => {
      const prompt = "Rewrite the follow-up.\n\n### output\n";
      const body = buildOpenAiChatBody(
        { prompt, responseFormat: format },
        "qwen/qwen3.6-plus",
        stream,
      );
      expect(body.response_format).toBeDefined();
      expect(sentPrompt(body)).toBe(`${prompt}\n${JSON_RESPONSE_INSTRUCTION}`);
    },
  );

  it("separates the instruction with a blank line from a prompt without a trailing newline", () => {
    const body = buildOpenAiChatBody(
      { prompt: "candidates:\n[1] a\n\nlinks:", responseFormat: format },
      "m",
      false,
    );
    expect(sentPrompt(body)).toBe(
      `candidates:\n[1] a\n\nlinks:\n\n${JSON_RESPONSE_INSTRUCTION}`,
    );
  });

  it.each(["Emit JSON only.", "a json object", "the Json schema"])(
    "leaves a prompt that already mentions it alone: %s",
    (prompt) => {
      const body = buildOpenAiChatBody(
        { prompt, responseFormat: format },
        "m",
        false,
      );
      expect(body.response_format).toBeDefined();
      expect(sentPrompt(body)).toBe(prompt);
    },
  );

  it("does not touch the prompt of a request without response_format", () => {
    const body = buildOpenAiChatBody(
      { prompt: "### output\n" },
      "m",
      false,
    );
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "### output\n" }],
        temperature: 0.2,
        stream: false,
      }),
    );
  });

  it("leaves a tools request byte-identical even when it also asks for a response format", () => {
    // `response_format` is never combined with `tools`, so neither is
    // the instruction that exists only to go with it.
    const request = { prompt: "main step", tools, toolChoice: "auto" };
    const plain = buildOpenAiChatBody(request, "m", true);
    const withFormat = buildOpenAiChatBody(
      { ...request, responseFormat: format },
      "m",
      true,
    );
    expect(withFormat.response_format).toBeUndefined();
    expect(sentPrompt(withFormat)).toBe("main step");
    expect(JSON.stringify(withFormat)).toBe(JSON.stringify(plain));
  });

  it("keeps the main agent turn's body exactly as it was", () => {
    // A native-tools turn: streamed, tools, no response format. Pinned
    // as the literal wire object, key order included.
    const body = buildOpenAiChatBody(
      {
        prompt: "stable prefix\n### user\nhi",
        tools,
        toolChoice: "auto",
        parallelToolCalls: true,
      },
      "gpt-test",
      true,
    );
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "stable prefix\n### user\nhi" }],
        temperature: 0.2,
        stream: true,
        stream_options: { include_usage: true },
        tools,
        parallel_tool_calls: true,
        tool_choice: "auto",
      }),
    );
  });

  it("keeps the instruction when extraBody tries to replace the messages", () => {
    const body = buildOpenAiChatBody(
      { prompt: "### votes\n", responseFormat: format },
      "m",
      false,
      { messages: [{ role: "user", content: "### votes\n" }] },
    );
    expect(sentPrompt(body)).toBe(`### votes\n\n${JSON_RESPONSE_INSTRUCTION}`);
  });
});
