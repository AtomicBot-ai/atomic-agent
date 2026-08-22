import { describe, expect, it } from "vitest";
import { LlamaServerClient } from "./llama-server-client.js";

// URL-construction cases live in their own file: the main client suite
// is already past the size budget, and these tests share one concern —
// the base URL's own path must survive endpoint joins (the reverse-proxy
// shape the OpenAI-compatible route already handled).

function completionResponse(): Response {
  return new Response(
    JSON.stringify({
      content: "ok",
      stop: true,
      truncated: false,
      timings: { prompt_ms: 1, predicted_ms: 1, prompt_n: 1, predicted_n: 1 },
      tokens_cached: 0,
      slot_id: 0,
      model: "m",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("LlamaServerClient endpoint URLs", () => {
  it("keeps a reverse-proxy path prefix on /completion", async () => {
    const urls: string[] = [];
    const client = new LlamaServerClient({
      baseUrl: "https://box.example/llama",
      fetchImpl: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return completionResponse();
      }) as typeof fetch,
    });
    await client.complete({ prompt: "hi" });
    expect(urls).toEqual(["https://box.example/llama/completion"]);
  });

  it("keeps the prefix on /props", async () => {
    const urls: string[] = [];
    const client = new LlamaServerClient({
      baseUrl: "https://box.example/llama",
      fetchImpl: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ total_slots: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    await client.fetchProps();
    expect(urls).toEqual(["https://box.example/llama/props"]);
  });

  it("drops a trailing /v1 pasted from the openai-compatible field", async () => {
    const urls: string[] = [];
    const client = new LlamaServerClient({
      baseUrl: "http://192.168.1.50:8080/v1",
      fetchImpl: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return completionResponse();
      }) as typeof fetch,
    });
    await client.complete({ prompt: "hi" });
    expect(urls).toEqual(["http://192.168.1.50:8080/completion"]);
  });
});
