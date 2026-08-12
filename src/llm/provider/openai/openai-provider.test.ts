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

/** SSE-shaped fake for the streaming path: emits `content` as one delta, then done. */
function fakeStreamFetch(content: string) {
  const frame = (obj: Record<string, unknown>) => `data: ${JSON.stringify(obj)}\n\n`;
  const body =
    frame({
      model: "qwen-test",
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    }) +
    frame({
      model: "qwen-test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }) +
    "data: [DONE]\n\n";
  return vi.fn(
    async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
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

  it("streams deltas, then adapts the buffered tagged calls (buffer-then-adapt)", async () => {
    const tagged = [
      "<tool_call><function=os.fs.read><parameter=path>/tmp/a</parameter></function></tool_call>",
      "<tool_call><function=os.fs.read><parameter=path>/tmp/b</parameter></function></tool_call>",
    ].join("");
    const fetchImpl = fakeStreamFetch(tagged);
    const stream = provider(
      fetchImpl as unknown as typeof fetch,
      "qwen",
    ).completeStream({ prompt: "read", tools });

    // First yield is the live text delta (raw tagged text), not the final result.
    const first = await stream.next();
    expect(first.done).toBe(false);
    // Drain to the returned CompletionResult.
    let final: Awaited<ReturnType<typeof stream.next>> | undefined;
    while (true) {
      const next = await stream.next();
      if (next.done) {
        final = next;
        break;
      }
    }
    if (!final || !final.done) throw new Error("stream never completed");
    // The buffered final has the tagged text rewritten into tool_calls.
    expect(final.value.toolCalls?.map((call) => call.id)).toEqual([
      "call_qwen_tagged_0",
      "call_qwen_tagged_1",
    ]);
    expect(
      final.value.toolCalls?.map((call) => JSON.parse(call.function.arguments)),
    ).toEqual([{ path: "/tmp/a" }, { path: "/tmp/b" }]);
    expect(final.value.content).toBe("");
    expect(final.value.finishReason).toBe("tool_calls");

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ stream: true, tools });
  });
});
