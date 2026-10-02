import { afterEach, describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../../../config/index.js";
import { registerBuiltInProviderKinds } from "../registry/register-built-in-providers.js";
import { getProviderFactory } from "../registry/provider-types.js";
import type { LlmProvider } from "../llm-provider.js";

/**
 * Where an `openai-compatible` entry sends chat, as the preset saves it.
 *
 * Perplexity serves chat at `https://api.perplexity.ai/chat/completions`
 * and answers 404 under `/v1`, while its model list is the usual
 * `/v1/models` (both checked with a dummy key on 2026-10-02: the first
 * and the list answer 401, `/v1/chat/completions` 404).
 */

type Call = { url: string; headers: Record<string, string> };

function recordingFetch(calls: Call[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "sonar" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if ((init?.body as string | undefined)?.includes('"stream":true')) {
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response(
      JSON.stringify({
        model: "sonar",
        choices: [
          { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

async function compatProvider(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<LlmProvider> {
  registerBuiltInProviderKinds();
  const factory = getProviderFactory("openai-compatible");
  if (!factory) throw new Error("openai-compatible kind is not registered");
  vi.stubGlobal("fetch", fetchImpl);
  return factory({
    config: {} as AtomicAgentConfig,
    entry: {
      id: "perplexity",
      kind: "openai-compatible",
      baseUrl,
      apiKey: "pplx-route-test",
      defaultChatModel: "sonar",
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never,
  });
}

describe("openai-compatible chat route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts Perplexity chat to /chat/completions, unary and streamed", async () => {
    const calls: Call[] = [];
    const provider = await compatProvider(
      "https://api.perplexity.ai",
      recordingFetch(calls) as unknown as typeof fetch,
    );

    await provider.complete({ prompt: "hi", maxTokens: 16, temperature: 0 });
    const stream = provider.completeStream({ prompt: "hi" });
    await stream.next();

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.perplexity.ai/chat/completions",
      "https://api.perplexity.ai/chat/completions",
    ]);
    expect(calls[0]?.headers.authorization).toBe("Bearer pplx-route-test");
  });

  it("keeps Perplexity's model list and health check on /v1/models", async () => {
    const calls: Call[] = [];
    const provider = await compatProvider(
      "https://api.perplexity.ai",
      recordingFetch(calls) as unknown as typeof fetch,
    );

    await expect(provider.listModels?.()).resolves.toEqual(["sonar"]);
    await provider.health();

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.perplexity.ai/v1/models",
      "https://api.perplexity.ai/v1/models",
    ]);
  });

  it("finds the same route when the stored root still ends in /v1", async () => {
    const calls: Call[] = [];
    const provider = await compatProvider(
      "https://api.perplexity.ai/v1/",
      recordingFetch(calls) as unknown as typeof fetch,
    );

    await provider.complete({ prompt: "hi", maxTokens: 16, temperature: 0 });

    expect(calls[0]?.url).toBe("https://api.perplexity.ai/chat/completions");
  });

  it("leaves every other root on /v1/chat/completions", async () => {
    // Perplexity's Router API is a different root on the same host and
    // keeps the convention; so does every other preset.
    for (const [baseUrl, expected] of [
      [
        "https://api.perplexity.ai/router",
        "https://api.perplexity.ai/router/v1/chat/completions",
      ],
      [
        "https://api.groq.com/openai",
        "https://api.groq.com/openai/v1/chat/completions",
      ],
      ["https://api.x.ai", "https://api.x.ai/v1/chat/completions"],
    ] as const) {
      const calls: Call[] = [];
      const provider = await compatProvider(
        baseUrl,
        recordingFetch(calls) as unknown as typeof fetch,
      );
      await provider.complete({ prompt: "hi", maxTokens: 16, temperature: 0 });
      expect(calls[0]?.url).toBe(expected);
    }
  });
});
