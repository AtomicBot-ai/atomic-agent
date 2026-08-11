import { describe, expect, it, vi } from "vitest";

import {
  normalizeOpenRouterBaseUrl,
  OpenRouterProvider,
} from "./openrouter-provider.js";

describe("normalizeOpenRouterBaseUrl", () => {
  it("strips trailing /v1 from legacy configs", () => {
    expect(normalizeOpenRouterBaseUrl("https://openrouter.ai/api/v1")).toBe(
      "https://openrouter.ai/api",
    );
  });
});

describe("OpenRouterProvider", () => {
  it("sends app-attribution headers on the request", async () => {
    let sent: Headers | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          id: "gen-1",
          model: "openrouter/auto",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const provider = new OpenRouterProvider({
      id: "openrouter",
      apiKey: "test-key",
      defaultChatModel: "openrouter/auto",
      fetchImpl: fetchImpl as typeof fetch,
      requestTimeoutMs: 5000,
      httpReferer: "https://example.com",
      xTitle: "Example App",
      categories: "cli-agent,personal-agent",
    });

    await provider.complete({ prompt: "hi", maxTokens: 16, temperature: 0 });

    expect(sent?.get("HTTP-Referer")).toBe("https://example.com");
    expect(sent?.get("X-Title")).toBe("Example App");
    expect(sent?.get("X-OpenRouter-Categories")).toBe("cli-agent,personal-agent");
  });

  it("posts chat completions to /api/v1/chat/completions (not double /v1)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      return new Response(
        JSON.stringify({
          id: "gen-1",
          model: "openrouter/auto",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const provider = new OpenRouterProvider({
      id: "openrouter",
      apiKey: "test-key",
      defaultChatModel: "openrouter/auto",
      fetchImpl: fetchImpl as typeof fetch,
      requestTimeoutMs: 5000,
    });

    const result = await provider.complete({
      prompt: "hi",
      maxTokens: 16,
      temperature: 0,
    });

    expect(result.content).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("builds the streaming final result from SSE without a second request", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(
        sse([
          {
            id: "gen-1",
            model: "openai/gpt-5.5",
            choices: [{ delta: { role: "assistant" }, finish_reason: null }],
          },
          {
            id: "gen-1",
            model: "openai/gpt-5.5",
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      type: "function",
                      function: {
                        name: "reply",
                        arguments: "{\"text\":\"hel",
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "gen-1",
            model: "openai/gpt-5.5",
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: "lo\"}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
          {
            id: "gen-1",
            model: "openai/gpt-5.5",
            choices: [],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 2,
              total_tokens: 5,
            },
          },
          "[DONE]",
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });

    const provider = new OpenRouterProvider({
      id: "openrouter",
      apiKey: "test-key",
      defaultChatModel: "openai/gpt-5.5",
      fetchImpl: fetchImpl as typeof fetch,
      requestTimeoutMs: 5000,
    });

    const iterator = provider.completeStream({
      prompt: "hi",
      tools: [
        {
          type: "function",
          function: {
            name: "reply",
            description: "reply",
            parameters: { type: "object" },
          },
        },
      ],
      toolChoice: "auto",
      maxTokens: 16,
      temperature: 0,
    });
    const deltas: string[] = [];
    let final = null;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        final = next.value;
        break;
      }
      if (next.value.delta) deltas.push(next.value.delta);
    }

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(bodies[0]?.stream).toBe(true);
    expect(bodies[0]?.tool_choice).toBe("auto");
    expect(deltas.join("")).toBe("hello");
    expect(final?.modelId).toBe("openai/gpt-5.5");
    expect(final?.finishReason).toBe("tool_calls");
    expect(final?.usage?.totalTokens).toBe(5);
    expect(final?.toolCalls).toEqual([
      {
        id: "call-1",
        type: "function",
        function: { name: "reply", arguments: "{\"text\":\"hello\"}" },
      },
    ]);
  });
});

function sse(events: readonly Array<Record<string, unknown> | string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        const data = typeof event === "string" ? event : JSON.stringify(event);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      }
      controller.close();
    },
  });
}
