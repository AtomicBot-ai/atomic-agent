import { afterEach, describe, it, expect, vi } from "vitest";
import {
  LlamaServerClient,
  LlamaServerError,
  SLOTS_UNREACHABLE_BUDGET_MS,
  extractLlamaErrorDetail,
  judgeSlotProgress,
} from "./llama-server-client.js";

type Handler = (url: string, init: RequestInit) => Promise<Response>;

function createMockFetch(handler: Handler): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  }) as typeof fetch;
}

describe("LlamaServerClient n_predict from the turn's ceiling (F20)", () => {
  function clientCapturing(bodies: Array<Record<string, unknown>>): LlamaServerClient {
    return new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ content: "x", stop: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });
  }

  it("caps n_predict from maxOutputTokens, under the per-step maxTokens", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = clientCapturing(bodies);
    await client.complete({ prompt: "p", maxOutputTokens: 12_000 });
    await client.complete({ prompt: "p", maxOutputTokens: 12_000, maxTokens: 32_000 });
    expect(bodies[0]?.n_predict).toBe(12_000);
    expect(bodies[1]?.n_predict).toBe(32_000);
    // A reasoning effort means nothing to llama-server and is not sent.
    await client.complete({ prompt: "p", reasoningEffort: "low" });
    expect(JSON.stringify(bodies[2])).not.toContain("reasoning");
  });
});

describe("LlamaServerClient.measuredTokensPerSecond (F19)", () => {
  function clientWith(replies: Array<Record<string, unknown>>): LlamaServerClient {
    let i = 0;
    return new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async () => {
        const reply = replies[Math.min(i, replies.length - 1)]!;
        i += 1;
        return new Response(JSON.stringify({ content: "x", stop: true, ...reply }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });
  }

  it("is null until a completion reports timings, then a rolling mean", async () => {
    const client = clientWith([
      { timings: { predicted_per_second: 30 } },
      // An older server: no rate, but a count and a duration.
      { timings: { predicted_n: 100, predicted_ms: 10_000 } },
      // Nothing usable: ignored, the mean stands.
      { timings: { predicted_n: 0, predicted_ms: 0 } },
      {},
    ]);
    expect(client.measuredTokensPerSecond()).toBeNull();
    await client.complete({ prompt: "p" });
    expect(client.measuredTokensPerSecond()).toBe(30);
    await client.complete({ prompt: "p" });
    expect(client.measuredTokensPerSecond()).toBe(20);
    await client.complete({ prompt: "p" });
    await client.complete({ prompt: "p" });
    expect(client.measuredTokensPerSecond()).toBe(20);
  });

  it("keeps only the last eight completions, so it follows the load", async () => {
    const client = clientWith([{ timings: { predicted_per_second: 100 } }]);
    for (let i = 0; i < 3; i += 1) await client.complete({ prompt: "p" });
    const slow = clientWith([{ timings: { predicted_per_second: 100 } }]);
    void slow;
    // Eight slow completions push the fast ones out of the window.
    let n = 0;
    const mixed = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async () => {
        n += 1;
        return new Response(
          JSON.stringify({
            content: "x",
            stop: true,
            timings: { predicted_per_second: n <= 2 ? 100 : 10 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    });
    for (let i = 0; i < 10; i += 1) await mixed.complete({ prompt: "p" });
    expect(mixed.measuredTokensPerSecond()).toBe(10);
  });

  it("reads the stream's final event too", async () => {
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(
        async () =>
          new Response(
            'data: {"content":"ok","stop":false}\n\n' +
              'data: {"content":"","stop":true,"timings":{"predicted_per_second":42}}\n\n',
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      ),
    });
    const iterator = client.completeStream({ prompt: "hi" });
    let next = await iterator.next();
    while (!next.done) next = await iterator.next();
    expect(client.measuredTokensPerSecond()).toBe(42);
  });
});

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
              cache_n: 30,
            },
            // The whole prompt, and the slot's occupancy after the
            // request (prompt 70 + reply 8) — neither is the reused part.
            tokens_evaluated: 70,
            tokens_cached: 78,
            slot_id: 2,
            model: "qwen-test",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    });

    const result = await client.complete({
      prompt: "hello",
      grammar: 'root ::= "ok"',
      slotId: 2,
      maxTokens: 16,
    });

    expect(result.content).toBe('{"tool":"finish","args":{}}');
    expect(result.reasoningContent).toBe("");
    // 40 evaluated this request + 30 reused from the KV cache: the
    // prompt the model saw was 70 tokens, and that is what occupancy
    // consumers (the TUI context chip among them) need reported.
    expect(result.timing.promptTokens).toBe(70);
    expect(result.cacheHitTokens).toBe(30);
    expect(result.slotId).toBe(2);
    expect(result.modelId).toBe("qwen-test");
    expect(captured).not.toBeNull();
    const snapshot = captured as unknown as {
      url: string;
      body: Record<string, unknown>;
    };
    expect(snapshot.url).toBe("http://127.0.0.1:9999/completion");
    expect(snapshot.body.grammar).toBe('root ::= "ok"');
    expect(snapshot.body.slot_id).toBe(2);
    expect(snapshot.body.id_slot).toBe(2);
    expect(snapshot.body.cache_prompt).toBe(true);
    expect(snapshot.body.repeat_penalty).toBe(1.1);
    expect(snapshot.body.repeat_last_n).toBe(256);
  });

  it("reports the bare evaluated count when nothing was cached", async () => {
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(
        async () =>
          new Response(
            JSON.stringify({
              content: "ok",
              stop: true,
              truncated: false,
              timings: {
                prompt_ms: 10,
                predicted_ms: 20,
                prompt_n: 40,
                predicted_n: 8,
              },
              slot_id: 0,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    });

    const result = await client.complete({ prompt: "hello", maxTokens: 16 });

    expect(result.timing.promptTokens).toBe(40);
    expect(result.cacheHitTokens).toBe(0);
  });

  /** One unary completion whose response carries `payload`'s usage fields. */
  async function completeWith(payload: Record<string, unknown>) {
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(
        async () =>
          new Response(
            JSON.stringify({ content: "ok", stop: true, slot_id: 0, ...payload }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    });
    return client.complete({ prompt: "hello", maxTokens: 16 });
  }

  it("counts a warm-cache prompt once, from the timings split", async () => {
    // A typical worker step: most of the prompt reused, a little
    // evaluated, and `tokens_cached` reporting occupancy after the reply.
    // The old sum (`prompt_n + tokens_cached`) made this 13,600.
    const result = await completeWith({
      timings: { prompt_n: 1_200, cache_n: 10_800, predicted_n: 400 },
      tokens_evaluated: 12_000,
      tokens_cached: 12_400,
    });
    expect(result.timing.promptTokens).toBe(12_000);
    expect(result.cacheHitTokens).toBe(10_800);
    expect(result.timing.predictedTokens).toBe(400);
  });

  it("matches the metering proxy's prompt count on the benchmark totals", async () => {
    // Ground truth from a metering proxy: 433,110 prompt tokens, of
    // which 35,635 evaluated and 397,475 reused. The old formula read the
    // same fields as 499,542.
    const result = await completeWith({
      timings: { prompt_n: 35_635, cache_n: 397_475, predicted_n: 30_797 },
      tokens_cached: 463_907,
    });
    expect(result.timing.promptTokens).toBe(433_110);
    expect(result.cacheHitTokens).toBe(397_475);
    expect(35_635 + 463_907).toBe(499_542);
  });

  it("reads tokens_evaluated as the whole prompt when timings are absent", async () => {
    const result = await completeWith({
      tokens_evaluated: 70,
      tokens_cached: 78,
      tokens_predicted: 8,
    });
    expect(result.timing.promptTokens).toBe(70);
    // `tokens_cached` is occupancy, not reuse, so no reuse is claimed.
    expect(result.cacheHitTokens).toBe(0);
    expect(result.timing.predictedTokens).toBe(8);
  });

  it("derives the reused part when an older server sends prompt_n but no cache_n", async () => {
    const result = await completeWith({
      timings: { prompt_n: 40, predicted_n: 8 },
      tokens_evaluated: 70,
      tokens_cached: 78,
    });
    expect(result.timing.promptTokens).toBe(70);
    expect(result.cacheHitTokens).toBe(30);
  });

  it("reads the same split from a stream's final event", async () => {
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(
        async () =>
          new Response(
            'data: {"content":"ok","stop":false}\n\n' +
              'data: {"content":"","stop":true,"timings":{"prompt_n":5,"cache_n":95,"predicted_n":1},"tokens_evaluated":100,"tokens_cached":101}\n\n',
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      ),
    });
    const iterator = client.completeStream({ prompt: "hi" });
    let next = await iterator.next();
    while (!next.done) next = await iterator.next();
    if (!next.done) throw new Error("stream did not finish");
    expect(next.value.timing.promptTokens).toBe(100);
    expect(next.value.cacheHitTokens).toBe(95);
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
      fetchImpl: createMockFetch(
        async () => new Response("boom", { status: 503 }),
      ),
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

  it("keeps the errno and the original error on a network failure", async () => {
    // Without these, every unreachable-daemon failure is indistinguishable
    // from every died-mid-generation one: same name, same null status,
    // same empty message in an error report.
    const cause = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:9999"),
      { code: "ECONNREFUSED" },
    );
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause });
      }),
      completionRetries: 1,
    });
    await expect(client.complete({ prompt: "x" })).rejects.toMatchObject({
      name: "LlamaServerError",
      status: null,
      code: "ECONNREFUSED",
    });
  });

  it("leaves `code` undefined when the transport left no errno", async () => {
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async () => {
        throw new Error("something opaque");
      }),
      completionRetries: 1,
    });
    await expect(client.complete({ prompt: "x" })).rejects.toMatchObject({
      name: "LlamaServerError",
      code: undefined,
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

  // A slow model that blows `requestTimeoutMs` surfaces as an abort with
  // `status === null`, structurally identical to a dropped socket. Retrying
  // it burns another full timeout of GPU time per attempt and cannot
  // succeed, so it must short-circuit like a 4xx does.
  it("does not retry when its own requestTimeoutMs fires", async () => {
    let calls = 0;
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      requestTimeoutMs: 5,
      fetchImpl: createMockFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            calls += 1;
            init.signal?.addEventListener("abort", () => {
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              );
            });
          }),
      ),
      completionRetries: 5,
      completionRetryBackoffMs: 0,
      sleep: async () => {},
    });
    await expect(client.complete({ prompt: "hi" })).rejects.toMatchObject({
      name: "LlamaServerError",
      status: null,
      timedOut: true,
    });
    expect(calls).toBe(1);
  });

  it("still retries genuine transport failures", async () => {
    let calls = 0;
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      requestTimeoutMs: 60_000,
      fetchImpl: createMockFetch(async () => {
        calls += 1;
        throw new Error("ECONNRESET");
      }),
      completionRetries: 3,
      completionRetryBackoffMs: 0,
      sleep: async () => {},
    });
    await expect(client.complete({ prompt: "hi" })).rejects.toMatchObject({
      timedOut: false,
    });
    expect(calls).toBe(3);
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

  it("folds the server error body into the LlamaServerError message", async () => {
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 400,
                message:
                  "the request exceeds the available context size, try increasing it",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      ),
      completionRetries: 1,
    });
    await expect(client.complete({ prompt: "hi" })).rejects.toMatchObject({
      status: 400,
      message:
        "llama-server returned http 400: the request exceeds the available context size, try increasing it",
    });
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

/**
 * The streaming deadline is an *idle* deadline: `requestTimeoutMs` bounds
 * how long the server may stay silent, not how long the answer may be.
 * It used to bound the whole generation, so a healthy reasoning model on
 * CPU — or any llama-server on the far side of a LAN — was killed at
 * exactly the budget with every token already produced thrown away, and
 * neither the retry policy (`timedOut` is not retryable) nor the fallback
 * chain (a self-inflicted timeout is not an immediate signal) recovered
 * it. The cloud path never had this problem: `openAiFetch` clears its
 * timer as soon as the fetch promise settles, i.e. at response headers.
 */
describe("LlamaServerClient.completeStream deadlines", () => {
  interface PushableStream {
    response: Response;
    push: (text: string) => void;
    close: () => void;
    /** Error the body by hand — for streams that ignore the abort. */
    fail: () => void;
  }

  /**
   * An SSE body the test drives by hand. Aborting the request signal
   * errors the body mid-read, which is what undici does when the
   * controller fires while the response is still streaming — the
   * behaviour the production bug depends on.
   *
   * `errorOnAbort: false` models the narrow window in which the abort
   * has landed but bytes already sitting in the decode pipe are still
   * delivered; the test then errors the body itself with `fail()`.
   */
  function pushableSse(
    signal: AbortSignal | null | undefined,
    errorOnAbort = true,
  ): PushableStream {
    const encoder = new TextEncoder();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    let finished = false;
    const fail = (): void => {
      if (finished) return;
      finished = true;
      ctrl.error(
        Object.assign(new Error("The operation was aborted"), {
          name: "AbortError",
        }),
      );
    };
    if (errorOnAbort) signal?.addEventListener("abort", fail);
    return {
      response: new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      push: (text: string) => {
        if (!finished) ctrl.enqueue(encoder.encode(text));
      },
      close: () => {
        if (finished) return;
        finished = true;
        ctrl.close();
      },
      fail,
    };
  }

  function streamingClient(
    requestTimeoutMs: number,
    options: {
      streamTotalTimeoutMs?: number;
      errorOnAbort?: boolean;
      /** Defaults to `requestTimeoutMs`, so one number drives both deadlines. */
      firstTokenTimeoutMs?: number;
      /**
       * Answers the progress watch's `GET /slots`. Default: 501, the
       * answer of a server with the endpoint disabled — no verdict, so
       * the timers alone decide, as before the watch existed.
       */
      slots?: (init: RequestInit) => Promise<Response>;
      slotsPollIntervalMs?: number;
      slotsPollTimeoutMs?: number;
    } = {},
  ): {
    client: LlamaServerClient;
    opened: () => PushableStream;
    slotsPolls: () => number;
  } {
    let handle: PushableStream | null = null;
    let polls = 0;
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      requestTimeoutMs,
      firstTokenTimeoutMs: options.firstTokenTimeoutMs ?? requestTimeoutMs,
      ...(options.streamTotalTimeoutMs === undefined
        ? {}
        : { streamTotalTimeoutMs: options.streamTotalTimeoutMs }),
      ...(options.slotsPollIntervalMs === undefined
        ? {}
        : { slotsPollIntervalMs: options.slotsPollIntervalMs }),
      ...(options.slotsPollTimeoutMs === undefined
        ? {}
        : { slotsPollTimeoutMs: options.slotsPollTimeoutMs }),
      fetchImpl: createMockFetch(async (url, init) => {
        if (init.method === "GET" || url.endsWith("/slots")) {
          polls += 1;
          return options.slots
            ? options.slots(init)
            : new Response("slots endpoint disabled", { status: 501 });
        }
        handle = pushableSse(init.signal, options.errorOnAbort ?? true);
        return handle.response;
      }),
      completionRetries: 1,
      completionRetryBackoffMs: 0,
      sleep: async () => {},
    });
    return {
      client,
      opened: () => {
        if (!handle) throw new Error("stream not opened yet");
        return handle;
      },
      slotsPolls: () => polls,
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps streaming past requestTimeoutMs while chunks keep arriving", async () => {
    // The regression test. Six chunks 999ms apart is 5,994ms of healthy
    // generation under a 1,000ms budget — six times over the old
    // wall-clock cap, and every one of those gaps is under it.
    vi.useFakeTimers();
    const { client, opened } = streamingClient(1_000);
    const iterator = client.completeStream({ prompt: "hi" });
    const deltas: string[] = [];
    let final: { content: string } | null = null;
    const consumed = (async () => {
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          final = next.value;
          return;
        }
        if (next.value.delta) deltas.push(next.value.delta);
      }
    })();

    // Let the generator open the request and park on its first read().
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 6; i += 1) {
      opened().push(`data: {"content":"t${i}","stop":false}\n\n`);
      await vi.advanceTimersByTimeAsync(999);
    }
    opened().push('data: {"content":"","stop":true}\n\n');
    await vi.advanceTimersByTimeAsync(0);
    opened().close();
    await vi.advanceTimersByTimeAsync(0);
    await consumed;

    expect(deltas.join("")).toBe("t0t1t2t3t4t5");
    expect(final).not.toBeNull();
    expect(final!.content).toBe("t0t1t2t3t4t5");
  });

  it("aborts a stream that goes silent for longer than requestTimeoutMs", async () => {
    vi.useFakeTimers();
    const { client, opened } = streamingClient(1_000);
    const iterator = client.completeStream({ prompt: "hi" });
    const deltas: string[] = [];
    const failure = (async (): Promise<unknown> => {
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) return null;
          if (next.value.delta) deltas.push(next.value.delta);
        }
      } catch (err) {
        return err;
      }
    })();

    await vi.advanceTimersByTimeAsync(0);
    opened().push('data: {"content":"partial","stop":false}\n\n');
    await vi.advanceTimersByTimeAsync(500);
    // …and then the server goes quiet for a full budget.
    await vi.advanceTimersByTimeAsync(1_001);
    const err = await failure;

    expect(deltas.join("")).toBe("partial");
    expect(err).toBeInstanceOf(LlamaServerError);
    const llamaErr = err as LlamaServerError;
    expect(llamaErr.status).toBeNull();
    // Still `timedOut` — see the field's doc comment. llama-server sends
    // headers before it evaluates the prompt, so silence is not proof the
    // provider is dead, and flipping this would turn a slow local model
    // into an immediate fallover.
    expect(llamaErr.timedOut).toBe(true);
    expect(llamaErr.message).toContain("sent no data for 1000ms");
    // The old advice is wrong for a stall: nothing was too long.
    expect(llamaErr.message).not.toContain("lower completionMaxTokens");
  });

  it("still enforces a total deadline on the unary complete() path", async () => {
    // Pinned deliberately. A non-streaming request has exactly one event
    // to wait for, so it has no idle signal to refresh against — the
    // wall-clock budget is all it can have.
    vi.useFakeTimers();
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      requestTimeoutMs: 1_000,
      fetchImpl: createMockFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              );
            });
          }),
      ),
      completionRetries: 1,
      completionRetryBackoffMs: 0,
      sleep: async () => {},
    });
    const failure = client.complete({ prompt: "hi" }).then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(1_001);
    const err = (await failure) as LlamaServerError;

    expect(err).toBeInstanceOf(LlamaServerError);
    expect(err.timedOut).toBe(true);
    expect(err.message).toContain("exceeded requestTimeoutMs (1000ms)");
  });

  it("lets an external abort cancel mid-stream without reporting a timeout", async () => {
    // Esc in the TUI. The abort must not be laundered into our own
    // idle-timeout error: `timedOut` stays false, so the fallback chain
    // and `toLlmFailure` (which reads `ctx.signal.aborted`) still see a
    // cancellation rather than a provider failure.
    vi.useFakeTimers();
    const { client, opened } = streamingClient(60_000);
    const abort = new AbortController();
    const iterator = client.completeStream({
      prompt: "hi",
      signal: abort.signal,
    });
    const deltas: string[] = [];
    const failure = (async (): Promise<unknown> => {
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) return null;
          if (next.value.delta) deltas.push(next.value.delta);
        }
      } catch (err) {
        return err;
      }
    })();

    await vi.advanceTimersByTimeAsync(0);
    opened().push('data: {"content":"half","stop":false}\n\n');
    await vi.advanceTimersByTimeAsync(10);
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    const err = await failure;

    expect(deltas.join("")).toBe("half");
    expect(err).toBeInstanceOf(LlamaServerError);
    const llamaErr = err as LlamaServerError;
    expect(llamaErr.timedOut).toBe(false);
    expect(llamaErr.message).toMatch(/abort/i);
    expect(llamaErr.message).not.toContain("requestTimeoutMs");
    expect(llamaErr.message).not.toContain("sent no data");
  });

  it("reports a stall before the first token as a prompt eval, not a dead server", async () => {
    // llama.cpp sends response headers and *then* evaluates the prompt,
    // so this is the exact shape of the population this change exists to
    // protect: a healthy server grinding a long context on CPU. Telling
    // that user the server "stopped responding after starting the reply"
    // would just be a different piece of wrong advice.
    //
    // It also pins that a stream is on the `first-token` deadline from
    // the moment it is sent: were it still on the connect-phase `total`
    // budget, the error would come back with the unary wording.
    vi.useFakeTimers();
    const { client } = streamingClient(1_000);
    const iterator = client.completeStream({ prompt: "hi" });
    const failure = (async (): Promise<unknown> => {
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) return null;
        }
      } catch (err) {
        return err;
      }
    })();

    // Headers land, and then the body sends nothing at all.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_001);
    const err = (await failure) as LlamaServerError;

    expect(err).toBeInstanceOf(LlamaServerError);
    expect(err.status).toBeNull();
    expect(err.timedOut).toBe(true);
    expect(err.message).toContain("sent no first token within 1000ms");
    expect(err.message).toContain("still be evaluating the prompt");
    // The two wordings this one must not be confused with.
    expect(err.message).not.toContain("stopped responding");
    expect(err.message).not.toContain("after starting the reply");
    expect(err.message).not.toContain("exceeded requestTimeoutMs");
  });

  /** Drain a stream; `failure` resolves to the error it ended with, or `null`. */
  function drain(
    iterator: ReturnType<LlamaServerClient["completeStream"]>,
    deltas: string[] = [],
  ): { failure: Promise<unknown>; settled: () => boolean } {
    let done = false;
    const failure = (async (): Promise<unknown> => {
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) return null;
          if (next.value.delta) deltas.push(next.value.delta);
        }
      } catch (err) {
        return err;
      } finally {
        done = true;
      }
    })();
    return { failure, settled: () => done };
  }

  it("waits out a queued or prompt-evaluating stream on the first-token budget", async () => {
    // Fusion on one GPU: a worker's request waits behind the other slots'
    // prompt evals and sends nothing for minutes. On the idle budget it
    // was cancelled at exactly 300 s, its slot never having evaluated a
    // token. Scaled down here: idle 1 s, first token 10 s.
    vi.useFakeTimers();
    const { client, opened } = streamingClient(1_000, {
      firstTokenTimeoutMs: 10_000,
    });
    const deltas: string[] = [];
    const { failure, settled } = drain(
      client.completeStream({ prompt: "hi" }),
      deltas,
    );

    await vi.advanceTimersByTimeAsync(0);
    // Nine silent seconds: nine idle budgets, inside the first-token one.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(settled()).toBe(false);
    opened().push('data: {"content":"late start","stop":false}\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(deltas.join("")).toBe("late start");
    // Once the reply has started, silence is the idle budget's again.
    await vi.advanceTimersByTimeAsync(1_001);
    const err = (await failure) as LlamaServerError;

    expect(err).toBeInstanceOf(LlamaServerError);
    expect(err.timedOut).toBe(true);
    expect(err.message).toContain("sent no data for 1000ms");
  });

  it("names the first-token budget, and how to raise it, when that deadline fires", async () => {
    vi.useFakeTimers();
    const { client } = streamingClient(1_000, { firstTokenTimeoutMs: 10_000 });
    const { failure, settled } = drain(client.completeStream({ prompt: "hi" }));

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(9_990);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    const err = (await failure) as LlamaServerError;

    expect(err).toBeInstanceOf(LlamaServerError);
    expect(err.timedOut).toBe(true);
    expect(err.message).toContain("sent no first token within 10000ms");
    expect(err.message).toContain("queued behind other requests");
    expect(err.message).toContain("ATOMIC_AGENT_LLAMA_FIRST_TOKEN_TIMEOUT_MS");
    expect(err.message).not.toContain("raise localModels.requestTimeoutMs");
  });

  it("bounds the wait for response headers by the first-token budget as well", async () => {
    // Some llama.cpp builds hold the headers back until the first result,
    // which puts the queue and the prompt eval in front of them.
    vi.useFakeTimers();
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      requestTimeoutMs: 1_000,
      firstTokenTimeoutMs: 10_000,
      fetchImpl: createMockFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              );
            });
          }),
      ),
      completionRetries: 1,
      completionRetryBackoffMs: 0,
      sleep: async () => {},
    });
    const { failure, settled } = drain(client.completeStream({ prompt: "hi" }));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_001);
    const err = (await failure) as LlamaServerError;

    expect(err).toBeInstanceOf(LlamaServerError);
    expect(err.timedOut).toBe(true);
    expect(err.message).toContain("sent no first token within 10000ms");
  });

  it("never gives the first token less time than the idle budget", async () => {
    // Before the budgets were split, "raise requestTimeoutMs" was the
    // advice for a slow prompt eval; an operator who took it keeps it.
    vi.useFakeTimers();
    const { client } = streamingClient(5_000, { firstTokenTimeoutMs: 1_000 });
    const { failure, settled } = drain(client.completeStream({ prompt: "hi" }));

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    const err = (await failure) as LlamaServerError;

    expect(err.message).toContain("sent no first token within 5000ms");
  });

  it("caps one streaming response with streamTotalTimeoutMs even while chunks keep arriving", async () => {
    // The idle deadline is not an upper bound: a server emitting one
    // byte every (budget - 1)ms refreshes it forever. Without this cap a
    // wedged or hostile llama-server pins a slot, a session and — under
    // headless `run` — the process, with nothing else on the turn path
    // to stop it (`ctx.signal` is user-driven only).
    vi.useFakeTimers();
    const { client, opened } = streamingClient(1_000, {
      streamTotalTimeoutMs: 5_000,
    });
    const iterator = client.completeStream({ prompt: "hi" });
    const deltas: string[] = [];
    const failure = (async (): Promise<unknown> => {
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) return null;
          if (next.value.delta) deltas.push(next.value.delta);
        }
      } catch (err) {
        return err;
      }
    })();

    await vi.advanceTimersByTimeAsync(0);
    // 900ms apart: every gap is inside the 1,000ms idle budget, so the
    // idle deadline can never fire. Only the cap can.
    for (let i = 0; i < 20; i += 1) {
      opened().push('data: {"content":"t","stop":false}\n\n');
      await vi.advanceTimersByTimeAsync(900);
    }
    const err = (await failure) as LlamaServerError;

    expect(err).toBeInstanceOf(LlamaServerError);
    expect(err.status).toBeNull();
    expect(err.timedOut).toBe(true);
    // It streamed healthily right up to the cap.
    expect(deltas.length).toBeGreaterThanOrEqual(5);
    expect(err.message).toContain("streamTotalTimeoutMs (5000ms)");
    expect(err.message).toContain("ATOMIC_AGENT_LLAMA_STREAM_TOTAL_TIMEOUT_MS");
    // Not a stall, and the user must not be sent looking for one.
    expect(err.message).not.toContain("sent no data for");
    expect(err.message).not.toContain("sent no first token");
  });

  it("does not let a byte still in flight rewrite which deadline fired", async () => {
    // `keepAlive()` is a no-op once a deadline has fired or the caller
    // has aborted. The window is narrow but real: the abort lands while
    // bytes already sitting in the decode pipe are still delivered, and
    // the read loop calls `keepAlive()` on each of them. Without the
    // guard those late bytes re-arm the timer, which fires a second time
    // and overwrites the recorded reason — so the user is told the
    // server stalled mid-reply when what actually happened is that it
    // never produced a first token.
    vi.useFakeTimers();
    const { client, opened } = streamingClient(1_000, { errorOnAbort: false });
    const iterator = client.completeStream({ prompt: "hi" });
    const failure = (async (): Promise<unknown> => {
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) return null;
        }
      } catch (err) {
        return err;
      }
    })();

    await vi.advanceTimersByTimeAsync(0);
    // Silence past the budget: the first-token deadline fires and aborts.
    await vi.advanceTimersByTimeAsync(1_001);
    // …and only now does the byte that was already in flight land.
    opened().push('data: {"content":"late","stop":false}\n\n');
    await vi.advanceTimersByTimeAsync(0);
    // Long enough for a re-armed deadline to fire a second time.
    await vi.advanceTimersByTimeAsync(2_000);
    opened().fail();
    const err = (await failure) as LlamaServerError;

    expect(err).toBeInstanceOf(LlamaServerError);
    expect(err.message).toContain("sent no first token within 1000ms");
    expect(err.message).not.toContain("sent no data for");
  });

  describe("the /slots progress watch (F14)", () => {
    const slotsJson = (slots: unknown[]) => async () =>
      new Response(JSON.stringify(slots), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const idle = (id: number) => ({ id, id_task: -1, is_processing: false, next_token: { n_decoded: 0 } });
    const busy = (id: number, decoded = 0) => ({ id, id_task: 7, is_processing: true, next_token: { n_decoded: decoded } });

    it("aborts a first-token wait early when /slots keeps answering with nothing going on", async () => {
      // Idle budget 60 s, first-token budget 30 min. A server that answers
      // /slots every 15 s with every slot idle and unchanged is not
      // processing the request; the wait ends after one idle budget, not
      // thirty minutes.
      vi.useFakeTimers();
      const { client, slotsPolls } = streamingClient(60_000, {
        firstTokenTimeoutMs: 30 * 60_000,
        slots: slotsJson([idle(0), idle(1)]),
      });
      const stream = client.completeStream({
        prompt: "p",
        sessionId: "s",
        slotId: 0,
      });
      const first = stream.next();
      const failure = first.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(slotsPolls()).toBe(3);
      await vi.advanceTimersByTimeAsync(2_000);
      const err = await failure;
      expect(err).toBeInstanceOf(LlamaServerError);
      expect((err as LlamaServerError).timedOut).toBe(true);
      expect((err as LlamaServerError).message).toContain("sent no first token");
      expect((err as LlamaServerError).message).toContain("no progress for 60000ms");
      expect((err as LlamaServerError).message).toContain("reuses this session's slot");
    });

    it("keeps waiting up to the first-token budget while this session's slot is processing", async () => {
      vi.useFakeTimers();
      const { client, opened, slotsPolls } = streamingClient(60_000, {
        firstTokenTimeoutMs: 10 * 60_000,
        slots: slotsJson([busy(0), idle(1)]),
      });
      const stream = client.completeStream({ prompt: "p", sessionId: "s", slotId: 0 });
      const first = stream.next();
      // Nine minutes of "processing, nothing decoded yet" — prompt
      // evaluation looks exactly like this — and nothing aborts.
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      expect(slotsPolls()).toBeGreaterThan(30);
      opened().push('data: {"content":"hi","stop":false}\n\n');
      const chunk = await first;
      expect(chunk.done).toBe(false);
      expect((chunk.value as { delta: string }).delta).toBe("hi");
      opened().close();
    });

    it("reads another slot's work as this request being queued, and a changed idle table as movement", async () => {
      vi.useFakeTimers();
      let tick = 0;
      const { client, opened } = streamingClient(60_000, {
        firstTokenTimeoutMs: 10 * 60_000,
        slots: async () => {
          tick += 1;
          // Another slot busy for the first 8 polls, then the table
          // changes (a task finished) — both count as progress.
          const table = tick <= 8 ? [idle(0), busy(1, tick)] : [idle(0), { ...idle(1), id_task: 100 + tick }];
          return new Response(JSON.stringify(table), { status: 200 });
        },
      });
      const stream = client.completeStream({ prompt: "p", sessionId: "s", slotId: 0 });
      const first = stream.next();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      opened().push('data: {"content":"x","stop":false}\n\n');
      expect((await first).done).toBe(false);
      opened().close();
    });

    it("falls back to the first-token timer when /slots itself hangs (the busy-server case)", async () => {
      // Measured: /slots does not answer while a slot evaluates a large
      // prompt. A poll that times out is no verdict; the first-token
      // budget is what ends the wait, exactly as before the watch.
      vi.useFakeTimers();
      let hung = 0;
      const { client } = streamingClient(60_000, {
        firstTokenTimeoutMs: 5 * 60_000,
        slots: (init) =>
          new Promise<Response>((_, reject) => {
            hung += 1;
            init.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      });
      const stream = client.completeStream({ prompt: "p", sessionId: "s", slotId: 0 });
      const failure = stream.next().catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(hung).toBeGreaterThan(10);
      await vi.advanceTimersByTimeAsync(60_000);
      const err = await failure;
      expect((err as LlamaServerError).message).toContain("no first token within 300000ms");
    });

    it("ends the wait as unreachable when /slots stops answering altogether", async () => {
      // Issue #490. An unanswered poll used to refresh the stall clock,
      // so a server that answered nothing at all read as "busy" and only
      // the 30-minute first-token budget could end the wait — which is
      // how a Fusion worker burned its whole budget with zero steps.
      // Now the unanswered run has its own clock.
      vi.useFakeTimers();
      let polls = 0;
      const { client } = streamingClient(60_000, {
        firstTokenTimeoutMs: 30 * 60_000,
        slots: async () => {
          polls += 1;
          throw Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
          });
        },
      });
      const failure = client
        .completeStream({ prompt: "p", sessionId: "s", slotId: 0 })
        .next()
        .catch((err: unknown) => err);

      // One budget minus a poll interval: plenty of failed polls, no abort.
      await vi.advanceTimersByTimeAsync(SLOTS_UNREACHABLE_BUDGET_MS - 15_000);
      expect(polls).toBeGreaterThan(30);
      await vi.advanceTimersByTimeAsync(30_000);

      const err = (await failure) as LlamaServerError;
      expect(err).toBeInstanceOf(LlamaServerError);
      expect(err.timedOut).toBe(true);
      expect(err.message).toContain("stopped answering GET /slots entirely");
      expect(err.message).toContain(`for ${SLOTS_UNREACHABLE_BUDGET_MS}ms`);
      expect(err.message).toContain("it is unreachable");
      // Not the slow-model diagnosis, and not the stall one either.
      expect(err.message).not.toContain("evaluating the prompt");
      expect(err.message).not.toContain("every slot idle");
    });

    it("does not abort on a transient poll failure that a later answer clears", async () => {
      // One failed poll against a busy server is ordinary — /slots is
      // known to hang while a slot evaluates a large prompt, which is
      // exactly when the wait is most worth keeping.
      vi.useFakeTimers();
      let polls = 0;
      const { client, opened } = streamingClient(60_000, {
        firstTokenTimeoutMs: 4 * SLOTS_UNREACHABLE_BUDGET_MS,
        slots: async () => {
          polls += 1;
          // Every third poll fails; the rest report real work.
          if (polls % 3 === 0) throw new Error("socket hang up");
          return new Response(JSON.stringify([busy(0, polls)]), { status: 200 });
        },
      });
      const first = client
        .completeStream({ prompt: "p", sessionId: "s", slotId: 0 })
        .next();
      const failure = first.catch((err: unknown) => err);

      // Three unreachable budgets' worth of the same pattern: the run of
      // unanswered polls never gets past one, so nothing fires.
      await vi.advanceTimersByTimeAsync(3 * SLOTS_UNREACHABLE_BUDGET_MS);
      expect(polls).toBeGreaterThan(100);
      opened().push('data: {"content":"hi","stop":false}\n\n');
      const chunk = (await failure) as IteratorResult<{ delta: string }>;
      expect(chunk.done).toBe(false);
      expect(chunk.value.delta).toBe("hi");
      opened().close();
    });

    it("never aborts a server that is genuinely working, however long it takes", async () => {
      // The other direction of the same change: a busy server answers
      // every poll, so neither clock can reach its budget.
      vi.useFakeTimers();
      const { client, opened } = streamingClient(60_000, {
        firstTokenTimeoutMs: 4 * SLOTS_UNREACHABLE_BUDGET_MS,
        slots: slotsJson([busy(0), busy(1, 9)]),
      });
      const first = client
        .completeStream({ prompt: "p", sessionId: "s", slotId: 0 })
        .next();
      await vi.advanceTimersByTimeAsync(3 * SLOTS_UNREACHABLE_BUDGET_MS);
      opened().push('data: {"content":"ok","stop":false}\n\n');
      expect((await first).done).toBe(false);
      opened().close();
    });

    it("latches a build without /slots instead of pretending to watch it", async () => {
      // 501 (or 404) is the opposite of unreachable: the server answered,
      // it just has no such endpoint, and it never will while it runs.
      // Aborting on that would break every user on such a build, so the
      // watch latches the fact, stops polling, and the first-token
      // timeout says outright that nothing was watching.
      vi.useFakeTimers();
      let polls = 0;
      const { client } = streamingClient(60_000, {
        firstTokenTimeoutMs: 90_000,
        slots: async () => {
          polls += 1;
          return new Response("slots endpoint disabled", { status: 501 });
        },
      });
      const failure = client
        .completeStream({ prompt: "p", sessionId: "s", slotId: 0 })
        .next()
        .catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(91_000);
      const err = (await failure) as LlamaServerError;
      expect(err.message).toContain("sent no first token within 90000ms");
      expect(err.message).toContain("no /slots endpoint");
      // Polled once, learned the endpoint is absent, stopped.
      expect(polls).toBe(1);
      expect(client.slotsWatchUnavailable()).toBe(true);

      // And the next request on the same server does not probe again.
      const second = client
        .completeStream({ prompt: "p2", sessionId: "s", slotId: 0 })
        .next()
        .catch((err2: unknown) => err2);
      await vi.advanceTimersByTimeAsync(91_000);
      expect((await second) as LlamaServerError).toBeInstanceOf(LlamaServerError);
      expect(polls).toBe(1);
    });

    it("stops polling once the first byte arrives", async () => {
      vi.useFakeTimers();
      const { client, opened, slotsPolls } = streamingClient(60_000, {
        firstTokenTimeoutMs: 10 * 60_000,
        slots: slotsJson([busy(0)]),
      });
      const stream = client.completeStream({ prompt: "p", sessionId: "s", slotId: 0 });
      const first = stream.next();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(slotsPolls()).toBe(2);
      opened().push('data: {"content":"a","stop":false}\n\n');
      await first;
      await vi.advanceTimersByTimeAsync(45_000);
      expect(slotsPolls()).toBe(2);
      opened().close();
    });

    it("is off entirely when progressWatch is false", async () => {
      vi.useFakeTimers();
      let polls = 0;
      const client = new LlamaServerClient({
        baseUrl: "http://127.0.0.1:9999",
        requestTimeoutMs: 60_000,
        firstTokenTimeoutMs: 120_000,
        progressWatch: false,
        fetchImpl: createMockFetch(async (_url, init) => {
          if (init.method === "GET") {
            polls += 1;
            return new Response("[]", { status: 200 });
          }
          return pushableSse(init.signal).response;
        }),
        completionRetries: 1,
        completionRetryBackoffMs: 0,
        sleep: async () => {},
      });
      const failure = client
        .completeStream({ prompt: "p", sessionId: "s", slotId: 0 })
        .next()
        .catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(121_000);
      expect(polls).toBe(0);
      expect((await failure) as LlamaServerError).toBeInstanceOf(LlamaServerError);
    });
  });
});

describe("judgeSlotProgress", () => {
  const idle = (id: number) => ({ id, id_task: -1, is_processing: false, next_token: { n_decoded: 0 } });

  it("is progress while any slot processes, idle only when nothing moves twice", () => {
    expect(judgeSlotProgress([{ ...idle(0), is_processing: true }], 0, null).kind).toBe("progress");
    expect(judgeSlotProgress([idle(0), { ...idle(1), is_processing: true }], 0, null).kind).toBe("progress");
    // An all-idle first answer is a baseline, not work.
    const first = judgeSlotProgress([idle(0), idle(1)], 0, null);
    expect(first.kind).toBe("idle");
    const again = judgeSlotProgress([idle(0), idle(1)], 0, (first as { snapshot: string }).snapshot);
    expect(again.kind).toBe("idle");
    const moved = judgeSlotProgress([idle(0), { ...idle(1), id_task: 9 }], 0, (first as { snapshot: string }).snapshot);
    expect(moved.kind).toBe("progress");
  });

  it("has no verdict on a body that is not a slot table", () => {
    expect(judgeSlotProgress({ error: "no" }, 0, null).kind).toBe("unknown");
    expect(judgeSlotProgress("x", -1, null).kind).toBe("unknown");
  });
});

describe("extractLlamaErrorDetail", () => {
  it("pulls the message from { error: { message } }", () => {
    expect(
      extractLlamaErrorDetail(
        JSON.stringify({ error: { code: 400, message: "context too small" } }),
      ),
    ).toBe("context too small");
  });

  it("pulls a string error field", () => {
    expect(
      extractLlamaErrorDetail(JSON.stringify({ error: "bad grammar" })),
    ).toBe("bad grammar");
  });

  it("falls back to a top-level message field", () => {
    expect(extractLlamaErrorDetail(JSON.stringify({ message: "boom" }))).toBe(
      "boom",
    );
  });

  it("returns trimmed raw text when the body is not JSON", () => {
    expect(extractLlamaErrorDetail("  plain error  ")).toBe("plain error");
  });

  it("returns an empty string for an empty body", () => {
    expect(extractLlamaErrorDetail("   ")).toBe("");
  });

  it("collapses whitespace and caps the length", () => {
    const long = "x".repeat(500);
    const out = extractLlamaErrorDetail(long);
    expect(out.length).toBe(300);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("LlamaServerClient.applyTemplate (F31)", () => {
  it("posts the messages and template kwargs to /apply-template and returns the prompt", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async (url, init) => {
        captured = {
          url,
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        };
        return new Response(
          JSON.stringify({
            prompt: "<|im_start|>system\nS<|im_end|>\n<|im_start|>user\nU<|im_end|>\n<|im_start|>assistant\n",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    });
    const prompt = await client.applyTemplate(
      [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
      ],
      { enable_thinking: false },
    );
    expect(prompt).toContain("<|im_start|>assistant\n");
    expect(captured!.url).toBe("http://127.0.0.1:9999/apply-template");
    expect(captured!.body).toEqual({
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
      ],
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("omits chat_template_kwargs when none are given, and types a missing endpoint", async () => {
    let body: Record<string, unknown> | null = null;
    const ok = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(async (_url, init) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ prompt: "p" }), { status: 200 });
      }),
    });
    await ok.applyTemplate([{ role: "user", content: "U" }]);
    expect(body).not.toHaveProperty("chat_template_kwargs");

    const missing = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: createMockFetch(
        async () => new Response("not found", { status: 404 }),
      ),
    });
    const err = await missing
      .applyTemplate([{ role: "user", content: "U" }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlamaServerError);
    expect((err as LlamaServerError).status).toBe(404);
  });
});
