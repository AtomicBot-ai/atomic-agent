import { describe, expect, it, vi } from "vitest";

import {
  OpenAiEmbeddingProvider,
  OpenRouterEmbeddingProvider,
} from "./openai-embedding-provider.js";

function embeddingResponse(dim: number): Response {
  return new Response(
    JSON.stringify({
      model: "openai/text-embedding-3-small",
      data: [{ embedding: new Array(dim).fill(0) }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("OpenAiEmbeddingProvider", () => {
  it("forwards extra headers on the embeddings request", async () => {
    let sent: Headers | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return embeddingResponse(3);
    });

    const provider = new OpenAiEmbeddingProvider({
      baseUrl: "https://example.com",
      apiKey: "test-key",
      model: "text-embedding-3-small",
      dim: 3,
      fetchImpl: fetchImpl as typeof fetch,
      headers: { "X-Custom": "yes" },
    });

    await provider.embed({ text: "hello" });

    expect(sent?.get("X-Custom")).toBe("yes");
    expect(sent?.get("authorization")).toBe("Bearer test-key");
  });
});

describe("OpenRouterEmbeddingProvider", () => {
  it("sends app-attribution headers on the embeddings request", async () => {
    let sent: Headers | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/v1/embeddings");
      sent = new Headers(init?.headers);
      return embeddingResponse(1536);
    });

    const provider = new OpenRouterEmbeddingProvider({
      baseUrl: "https://openrouter.ai/api",
      apiKey: "test-key",
      model: "openai/text-embedding-3-small",
      dim: 1536,
      fetchImpl: fetchImpl as typeof fetch,
      httpReferer: "https://example.com",
      xTitle: "Example App",
      categories: "cli-agent,personal-agent",
    });

    await provider.embed({ text: "hello" });

    expect(sent?.get("HTTP-Referer")).toBe("https://example.com");
    expect(sent?.get("X-Title")).toBe("Example App");
    expect(sent?.get("X-OpenRouter-Categories")).toBe("cli-agent,personal-agent");
  });
});
