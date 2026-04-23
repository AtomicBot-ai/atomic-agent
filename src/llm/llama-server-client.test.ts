import { describe, it, expect } from "vitest";
import { LlamaServerClient, LlamaServerError } from "./llama-server-client.js";

type Handler = (url: string, init: RequestInit) => Promise<Response>;

function createMockFetch(handler: Handler): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  }) as typeof fetch;
}

describe("LlamaServerClient.complete", () => {
  it("posts JSON to /completion with grammar and slot_id", async () => {
    let captured: { url: string; body: unknown } | null = null;
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async (url, init) => {
        captured = { url, body: JSON.parse(String(init.body)) };
        return new Response(
          JSON.stringify({
            content: '{"tool":"finish","args":{}}',
            stop: true,
            truncated: false,
            timings: {
              prompt_ms: 10,
              predicted_ms: 20,
              prompt_n: 40,
              predicted_n: 8,
            },
            tokens_cached: 30,
            slot_id: 2,
            model: "qwen-test",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    });

    const result = await client.complete({
      prompt: "hello",
      grammar: "root ::= \"ok\"",
      slotId: 2,
      maxTokens: 16,
    });

    expect(result.content).toBe('{"tool":"finish","args":{}}');
    expect(result.reasoningContent).toBe("");
    expect(result.timing.promptTokens).toBe(40);
    expect(result.cacheHitTokens).toBe(30);
    expect(result.slotId).toBe(2);
    expect(result.modelId).toBe("qwen-test");
    expect(captured).not.toBeNull();
    const snapshot = captured as unknown as { url: string; body: Record<string, unknown> };
    expect(snapshot.url).toBe("http://127.0.0.1:9999/completion");
    expect(snapshot.body.grammar).toBe('root ::= "ok"');
    expect(snapshot.body.slot_id).toBe(2);
    expect(snapshot.body.id_slot).toBe(2);
    expect(snapshot.body.cache_prompt).toBe(true);
    expect(snapshot.body.repeat_penalty).toBe(1.1);
    expect(snapshot.body.repeat_last_n).toBe(256);
  });

  it("forwards explicit repeatPenalty / repeatLastN overrides", async () => {
    let captured: Record<string, unknown> | null = null;
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async (_url, init) => {
        captured = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ content: "{}", stop: true, truncated: false }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    });
    await client.complete({
      prompt: "hi",
      repeatPenalty: 1,
      repeatLastN: 64,
    });
    expect(captured).not.toBeNull();
    const body = captured as unknown as Record<string, unknown>;
    expect(body.repeat_penalty).toBe(1);
    expect(body.repeat_last_n).toBe(64);
  });

  it("throws LlamaServerError on non-2xx responses", async () => {
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async () => new Response("boom", { status: 503 })),
      completionRetries: 1,
    });
    await expect(client.complete({ prompt: "x" })).rejects.toBeInstanceOf(
      LlamaServerError,
    );
  });

  it("wraps network errors as LlamaServerError", async () => {
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async () => {
        throw new Error("ECONNREFUSED");
      }),
      completionRetries: 1,
    });
    await expect(client.complete({ prompt: "x" })).rejects.toMatchObject({
      name: "LlamaServerError",
      status: null,
    });
  });

  it("retries transient 5xx responses and eventually succeeds", async () => {
    let calls = 0;
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async () => {
        calls += 1;
        if (calls < 3) return new Response("unavailable", { status: 503 });
        return new Response(
          JSON.stringify({
            content: '{"tool":"finish","args":{}}',
            stop: true,
            truncated: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
      completionRetries: 3,
      completionRetryBackoffMs: 0,
      sleep: async () => {},
    });
    const result = await client.complete({ prompt: "hi" });
    expect(calls).toBe(3);
    expect(result.content).toBe('{"tool":"finish","args":{}}');
  });

  it("retries network errors up to the configured attempt limit", async () => {
    let calls = 0;
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async () => {
        calls += 1;
        if (calls < 2) throw new Error("ECONNRESET");
        return new Response(
          JSON.stringify({ content: "ok", stop: true, truncated: false }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
      completionRetries: 4,
      completionRetryBackoffMs: 0,
      sleep: async () => {},
    });
    const result = await client.complete({ prompt: "hi" });
    expect(calls).toBe(2);
    expect(result.content).toBe("ok");
  });

  it("does not retry on 4xx grammar/validation errors", async () => {
    let calls = 0;
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async () => {
        calls += 1;
        return new Response("bad grammar", { status: 400 });
      }),
      completionRetries: 5,
      completionRetryBackoffMs: 0,
      sleep: async () => {},
    });
    await expect(client.complete({ prompt: "hi" })).rejects.toMatchObject({
      name: "LlamaServerError",
      status: 400,
    });
    expect(calls).toBe(1);
  });

  it("exhausts the retry budget and throws when all attempts fail", async () => {
    let calls = 0;
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async () => {
        calls += 1;
        return new Response("boom", { status: 502 });
      }),
      completionRetries: 3,
      completionRetryBackoffMs: 0,
      sleep: async () => {},
    });
    await expect(client.complete({ prompt: "hi" })).rejects.toMatchObject({
      name: "LlamaServerError",
      status: 502,
    });
    expect(calls).toBe(3);
  });

  it("fetches /props for model profile detection", async () => {
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async (url) => {
        expect(url).toBe("http://127.0.0.1:9999/props");
        return new Response(
          JSON.stringify({
            model_alias: "qwen3-30b-a3b-instruct-2507",
            chat_template: "<think>{{ reasoning }}</think>",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    });

    const props = await client.fetchProps();
    expect(props.model_alias).toBe("qwen3-30b-a3b-instruct-2507");
  });
});

describe("LlamaServerClient.completeStream", () => {
  function sseResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  it("yields deltas and returns the final result", async () => {
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async () =>
        sseResponse([
          'data: {"content":"hel","stop":false}\n\n',
          'data: {"content":"lo","stop":false}\n\n',
          'data: {"content":"","stop":true,"slot_id":1,"timings":{"prompt_ms":5,"predicted_ms":7,"prompt_n":3,"predicted_n":2}}\n\n',
        ]),
      ),
    });

    const iterator = client.completeStream({ prompt: "hi" });
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
    expect(deltas.join("")).toBe("hello");
    expect(final).not.toBeNull();
    expect(final!.content).toBe("hello");
    expect(final!.slotId).toBe(1);
  });

  it("handles split SSE frames across chunks", async () => {
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async () =>
        sseResponse([
          'data: {"content":"he',
          'llo","stop":false}\n\n',
          'data: {"content":"","stop":true}\n\n',
        ]),
      ),
    });
    const iterator = client.completeStream({ prompt: "hi" });
    const deltas: string[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.delta) deltas.push(next.value.delta);
    }
    expect(deltas.join("")).toBe("hello");
  });

  it("surfaces reasoning_content both as stream deltas and on the final result", async () => {
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async () =>
        sseResponse([
          'data: {"content":"","reasoning_content":"think ","stop":false}\n\n',
          'data: {"content":"hi","reasoning_content":"more","stop":false}\n\n',
          'data: {"content":"","reasoning_content":"","stop":true}\n\n',
        ]),
      ),
    });
    const iterator = client.completeStream({ prompt: "x" });
    const reasoningDeltas: string[] = [];
    const contentDeltas: string[] = [];
    let final = null;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        final = next.value;
        break;
      }
      if (next.value.delta) contentDeltas.push(next.value.delta);
      if (next.value.reasoningDelta)
        reasoningDeltas.push(next.value.reasoningDelta);
    }
    expect(contentDeltas.join("")).toBe("hi");
    expect(reasoningDeltas.join("")).toBe("think more");
    expect(final).not.toBeNull();
    expect(final!.reasoningContent).toBe("think more");
    expect(final!.content).toBe("hi");
  });

  it("retries a transient initial 5xx before the SSE body starts streaming", async () => {
    let calls = 0;
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async () => {
        calls += 1;
        if (calls < 2) return new Response("unavailable", { status: 503 });
        return sseResponse([
          'data: {"content":"hi","stop":false}\n\n',
          'data: {"content":"","stop":true}\n\n',
        ]);
      }),
      completionRetries: 3,
      completionRetryBackoffMs: 0,
      sleep: async () => {},
    });
    const iterator = client.completeStream({ prompt: "hi" });
    const deltas: string[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.delta) deltas.push(next.value.delta);
    }
    expect(calls).toBe(2);
    expect(deltas.join("")).toBe("hi");
  });

  it("reads reasoning_content from the unary response", async () => {
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(
        async () =>
          new Response(
            JSON.stringify({
              content: '{"tool":"reply","args":{"text":"ok"}}',
              reasoning_content: "the plan",
              stop: true,
              truncated: false,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    });
    const result = await client.complete({ prompt: "x" });
    expect(result.reasoningContent).toBe("the plan");
  });
});
