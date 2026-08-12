import { describe, expect, it, vi } from "vitest";

import type { CompletionRequest } from "../completion-types.js";
import { OpenAiProvider } from "./openai-provider.js";

const tools: NonNullable<CompletionRequest["tools"]> = [
  {
    type: "function",
    function: {
      name: "os__fs__read",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
  },
];

function fakeFetch(message: Record<string, unknown>) {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        model: "qwen-test",
        choices: [{ message, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

function provider(
  fetchImpl: typeof fetch,
  taggedToolCompatibility: "qwen" | undefined,
): OpenAiProvider {
  return new OpenAiProvider({
    id: "test",
    baseUrl: "https://example.invalid",
    apiKey: "",
    defaultChatModel: "qwen-test",
    fetchImpl,
    taggedToolCompatibility,
  });
}

describe("OpenAiProvider qwen tagged-tool compatibility", () => {
  it("adapts non-streaming responses with request tools only when opted in", async () => {
    const fetchImpl = fakeFetch({
      role: "assistant",
      content:
        "<tool_call><function=os.fs.read><parameter=path>/tmp/a</parameter></function></tool_call>",
    });

    const result = await provider(
      fetchImpl as unknown as typeof fetch,
      "qwen",
    ).complete({ prompt: "read", tools });

    expect(result.content).toBe("");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toMatchObject([
      {
        type: "function",
        function: { name: "os__fs__read", arguments: '{"path":"/tmp/a"}' },
      },
    ]);
  });

  it("leaves the existing OpenAI provider path unchanged by default", async () => {
    const tagged =
      "<tool_call><function=os.fs.read><parameter=path>/tmp/a</parameter></function></tool_call>";
    const result = await provider(
      fakeFetch({ role: "assistant", content: tagged }) as unknown as typeof fetch,
      undefined,
    ).complete({ prompt: "read", tools });

    expect(result.content).toBe(tagged);
    expect(result.toolCalls).toBeUndefined();
    expect(result.finishReason).toBe("stop");
  });

  it("preserves ordered distinct calls through compatibility streaming", async () => {
    const fetchImpl = fakeFetch({
      role: "assistant",
      content: [
        "<tool_call><function=os.fs.read><parameter=path>/tmp/a</parameter></function></tool_call>",
        "<tool_call><function=os.fs.read><parameter=path>/tmp/b</parameter></function></tool_call>",
      ].join(""),
    });
    const stream = provider(
      fetchImpl as unknown as typeof fetch,
      "qwen",
    ).completeStream({ prompt: "read", tools });

    const first = await stream.next();
    expect(first.done).toBe(true);
    if (!first.done) throw new Error("compatibility stream unexpectedly emitted text");
    expect(first.value.toolCalls?.map((call) => call.id)).toEqual([
      "call_qwen_tagged_0",
      "call_qwen_tagged_1",
    ]);
    expect(
      first.value.toolCalls?.map((call) => JSON.parse(call.function.arguments)),
    ).toEqual([{ path: "/tmp/a" }, { path: "/tmp/b" }]);

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ stream: false, tools });
  });
});
