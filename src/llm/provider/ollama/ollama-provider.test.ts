import { describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../../../config/index.js";
import {
  OllamaProvider,
  OLLAMA_AGENT_NUM_CTX,
  normalizeOllamaBaseUrl,
} from "./ollama-provider.js";
import { registerBuiltInProviderKinds } from "../registry/register-built-in-providers.js";
import { getProviderFactory } from "../registry/provider-types.js";

const CHAT_URL = "http://localhost:11434/api/chat";
const SHOW_URL = "http://localhost:11434/api/show";
const TAGS_URL = "http://localhost:11434/api/tags";

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Dispatch by URL: /api/show answers the num_ctx probe, the rest is the test's. */
function dispatchFetch(
  onChat: (init?: RequestInit) => Response | Promise<Response>,
  showBody: Record<string, unknown> | null = {
    model_info: { "qwen3.context_length": 262_144 },
  },
) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === SHOW_URL) {
      return showBody
        ? jsonResponse(showBody)
        : jsonResponse({ error: "model not found" }, 404);
    }
    expect(url).toBe(CHAT_URL);
    return onChat(init);
  });
}

async function buildOllamaProvider(fetchImpl: typeof fetch) {
  registerBuiltInProviderKinds();
  const factory = getProviderFactory("ollama");
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("ollama provider kind is not registered");
  vi.stubGlobal("fetch", fetchImpl);
  return factory({
    config: {} as AtomicAgentConfig,
    entry: {
      id: "ollama",
      kind: "ollama",
      defaultChatModel: "qwen3.6",
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

describe("OllamaProvider", () => {
  it("posts chat requests to the native path and maps the response", async () => {
    const fetchImpl = dispatchFetch((init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("qwen3.6");
      expect(body.stream).toBe(false);
      const options = body.options as Record<string, unknown>;
      expect(options.num_ctx).toBe(OLLAMA_AGENT_NUM_CTX);
      return jsonResponse({
        model: "qwen3.6",
        message: { role: "assistant", content: "ok", thinking: "hm" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 12,
        prompt_eval_duration: 91_000_000,
        eval_count: 5,
        eval_duration: 45_000_000,
      });
    });
    const provider = await buildOllamaProvider(fetchImpl as unknown as typeof fetch);

    const result = await provider.complete({
      prompt: "hi",
      maxTokens: 16,
      temperature: 0,
    });

    expect(result.content).toBe("ok");
    expect(result.reasoningContent).toBe("hm");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 17,
    });
    expect(result.timing.promptMs).toBe(91);
    expect(result.timing.predictedMs).toBe(45);
  });

  it("caps num_ctx by the trained context length from /api/show", async () => {
    const fetchImpl = dispatchFetch(
      (init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const options = body.options as Record<string, unknown>;
        expect(options.num_ctx).toBe(8192);
        return jsonResponse({
          message: { role: "assistant", content: "ok" },
          done: true,
        });
      },
      { model_info: { "llama.context_length": 8192 } },
    );
    const provider = await buildOllamaProvider(fetchImpl as unknown as typeof fetch);

    await provider.complete({ prompt: "hi", maxTokens: 16 });
    // The lookup is cached: a second completion adds one chat call, not
    // another /api/show round-trip.
    await provider.complete({ prompt: "again", maxTokens: 16 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("omits num_ctx when /api/show fails", async () => {
    const fetchImpl = dispatchFetch((init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const options = body.options as Record<string, unknown>;
      expect(options.num_ctx).toBeUndefined();
      return jsonResponse({
        message: { role: "assistant", content: "ok" },
        done: true,
      });
    }, null);
    const provider = await buildOllamaProvider(fetchImpl as unknown as typeof fetch);

    const result = await provider.complete({ prompt: "hi", maxTokens: 16 });
    expect(result.content).toBe("ok");
  });

  it("re-serializes object tool call arguments to the OpenAI string shape", async () => {
    const fetchImpl = dispatchFetch(() =>
      jsonResponse({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              function: {
                index: 0,
                name: "get_weather",
                arguments: { city: "Toronto" },
              },
            },
          ],
        },
        done: true,
        done_reason: "stop",
      }),
    );
    const provider = await buildOllamaProvider(fetchImpl as unknown as typeof fetch);

    const result = await provider.complete({
      prompt: "weather",
      maxTokens: 16,
      tools: [{ type: "function", function: { name: "get_weather" } }],
    });

    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Toronto"}' },
      },
    ]);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("streams NDJSON chunks with separate thinking deltas", async () => {
    const lines = [
      JSON.stringify({ message: { role: "assistant", thinking: "let me" }, done: false }),
      JSON.stringify({ message: { role: "assistant", content: "Th" }, done: false }),
      JSON.stringify({ message: { role: "assistant", content: "e end" }, done: false }),
      JSON.stringify({
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 9,
        eval_count: 4,
      }),
    ];
    const fetchImpl = dispatchFetch(
      () =>
        new Response(lines.join("\n") + "\n", {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        }),
    );
    const provider = await buildOllamaProvider(fetchImpl as unknown as typeof fetch);

    const stream = provider.completeStream({ prompt: "hello", maxTokens: 16 });
    const chunks = [];
    let final;
    while (true) {
      const next = await stream.next();
      if (next.done) {
        final = next.value;
        break;
      }
      chunks.push(next.value);
    }

    expect(chunks).toEqual([
      { delta: "", reasoningDelta: "let me", done: false },
      { delta: "Th", reasoningDelta: "", done: false },
      { delta: "e end", reasoningDelta: "", done: false },
    ]);
    expect(final.content).toBe("The end");
    expect(final.reasoningContent).toBe("let me");
    expect(final.usage).toEqual({
      promptTokens: 9,
      completionTokens: 4,
      totalTokens: 13,
    });
  });

  it("collects streamed tool calls arriving before the final chunk", async () => {
    const lines = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { index: 0, name: "list_files", arguments: { path: "." } } },
          ],
        },
        done: false,
      }),
      JSON.stringify({
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
      }),
    ];
    const fetchImpl = dispatchFetch(
      () => new Response(lines.join("\n") + "\n", { status: 200 }),
    );
    const provider = await buildOllamaProvider(fetchImpl as unknown as typeof fetch);

    const stream = provider.completeStream({
      prompt: "ls",
      maxTokens: 16,
      tools: [{ type: "function", function: { name: "list_files" } }],
    });
    let final;
    while (true) {
      const next = await stream.next();
      if (next.done) {
        final = next.value;
        break;
      }
    }

    expect(final.toolCalls).toEqual([
      {
        type: "function",
        function: { name: "list_files", arguments: '{"path":"."}' },
      },
    ]);
    expect(final.finishReason).toBe("tool_calls");
  });

  it("surfaces a mid-stream error line as a typed failure", async () => {
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: "par" }, done: false }),
      JSON.stringify({ error: "model runner has unexpectedly stopped" }),
    ];
    const fetchImpl = dispatchFetch(
      () => new Response(lines.join("\n") + "\n", { status: 200 }),
    );
    const provider = await buildOllamaProvider(fetchImpl as unknown as typeof fetch);

    const stream = provider.completeStream({ prompt: "hello", maxTokens: 16 });
    const error = await (async () => {
      try {
        while (true) {
          const next = await stream.next();
          if (next.done) return null;
        }
      } catch (caught) {
        return caught;
      }
    })();

    expect(String(error)).toContain("model runner has unexpectedly stopped");
  });

  it("strips a pasted /v1 suffix from the base URL", () => {
    expect(normalizeOllamaBaseUrl("http://localhost:11434/v1")).toBe(
      "http://localhost:11434",
    );
    expect(normalizeOllamaBaseUrl("http://localhost:11434/")).toBe(
      "http://localhost:11434",
    );
    expect(normalizeOllamaBaseUrl("https://ollama.com")).toBe(
      "https://ollama.com",
    );
  });

  it("lists and health-checks against /api/tags", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(TAGS_URL);
      return jsonResponse({
        models: [{ name: "qwen3.6:latest" }, { name: "gemma4:e4b" }],
      });
    });
    const provider = new OllamaProvider({
      id: "ollama",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.listModels?.()).resolves.toEqual([
      "gemma4:e4b",
      "qwen3.6:latest",
    ]);
    await expect(provider.health()).resolves.toMatchObject({
      reachable: true,
      status: 200,
    });
  });

  it("does not expose the API key in provider errors", async () => {
    const key = "ollama-secret-marker";
    const fetchImpl = vi.fn(
      async () => new Response("unauthorized", { status: 401 }),
    );
    const provider = new OllamaProvider({
      id: "ollama-cloud-native",
      baseUrl: "https://ollama.com",
      apiKey: key,
      defaultChatModel: "qwen3.6:cloud",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = await provider
      .complete({ prompt: "hi", maxTokens: 16, temperature: 0 })
      .catch((caught: unknown) => caught);

    expect(String(error)).not.toContain(key);
  });
});
