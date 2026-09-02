import { afterEach, describe, it, expect, vi } from "vitest";
import {
  LlamaServerClient,
  LlamaServerError,
  extractLlamaErrorDetail,
} from "./llama-server-client.js";

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
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
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
    options: { streamTotalTimeoutMs?: number; errorOnAbort?: boolean } = {},
  ): {
    client: LlamaServerClient;
    opened: () => PushableStream;
  } {
    let handle: PushableStream | null = null;
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      requestTimeoutMs,
      ...(options.streamTotalTimeoutMs === undefined
        ? {}
        : { streamTotalTimeoutMs: options.streamTotalTimeoutMs }),
      fetchImpl: createMockFetch(async (_url, init) => {
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
    // This is also the test that covers the `keepAlive()` call at
    // headers: delete it and the deadline is still the connect-phase
    // `total` budget, so the error comes back with the unary wording.
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
    expect(
      extractLlamaErrorDetail(JSON.stringify({ message: "boom" })),
    ).toBe("boom");
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
