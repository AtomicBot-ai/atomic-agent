import { afterEach, describe, expect, it, vi } from "vitest";

import { LlamaServerClient } from "./llama-server-client.js";
import type { StreamChunk } from "./llama-server-client.js";

/**
 * The client's per-request performance samples (issue #996): one per
 * completed call, committed only when the call succeeds, with how many
 * calls overlapped it and how long the first token took.
 */

const TIMINGS = {
  cache_n: 0,
  prompt_n: 2,
  prompt_ms: 32.969,
  prompt_per_second: 60.663047104856076,
  predicted_n: 40,
  predicted_ms: 1158.29,
  predicted_per_second: 33.67032435745798,
};

const FINAL = {
  content: "",
  stop: true,
  timings: TIMINGS,
  tokens_predicted: 40,
  tokens_evaluated: 2,
  model: "/home/user/models/Qwen3.6-35B-A3B-MXFP4_MOE.gguf",
};

const DELTA = 'data: {"content":"hi","stop":false}\n\n';
const STOP = `data: ${JSON.stringify(FINAL)}\n\n`;

type Reply = (init: RequestInit) => Response | Promise<Response>;

/** A client whose fetch answers from `replies` in order, the last one repeating. */
function clientWith(
  replies: Reply[],
  extra: { retries?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): { client: LlamaServerClient; calls: () => number } {
  let n = 0;
  const client = new LlamaServerClient({
    baseUrl: "http://127.0.0.1:9999",
    progressWatch: false,
    completionRetries: extra.retries ?? 1,
    completionRetryBackoffMs: extra.backoffMs ?? 0,
    sleep: extra.sleep ?? (async () => {}),
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      const reply = replies[Math.min(n, replies.length - 1)]!;
      n += 1;
      return reply(init ?? {});
    }) as typeof fetch,
  });
  return { client, calls: () => n };
}

function sse(chunks: string[], end: "close" | "error" = "close"): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]!));
        i += 1;
        return;
      }
      if (end === "close") controller.close();
      else controller.error(new TypeError("terminated"));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ok: Reply = () => sse([DELTA, STOP]);
const unaryOk: Reply = () => json({ ...FINAL, content: "hi" });
const unavailable: Reply = () => new Response("unavailable", { status: 503 });

async function drain(stream: AsyncGenerator<StreamChunk, unknown, void>): Promise<void> {
  let next = await stream.next();
  while (!next.done) next = await stream.next();
}

/** A fresh lone request on `client` records `concurrent: 1`: nothing was left open. */
async function expectNothingLeftOpen(client: LlamaServerClient): Promise<void> {
  const before = client.performanceSamples().length;
  await drain(client.completeStream({ prompt: "again" }));
  const samples = client.performanceSamples();
  expect(samples).toHaveLength(before + 1);
  expect(samples[samples.length - 1]?.concurrent).toBe(1);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LlamaServerClient performance samples", () => {
  it("records a streamed completion", async () => {
    const { client } = clientWith([ok]);
    expect(client.performanceCapacity).toBe(300);
    expect(client.performanceSamples()).toEqual([]);
    await drain(client.completeStream({ prompt: "p" }));
    const samples = client.performanceSamples();
    expect(samples).toHaveLength(1);
    const s = samples[0]!;
    expect(s).toMatchObject({
      streamed: true,
      concurrent: 1,
      modelId: "Qwen3.6-35B-A3B-MXFP4_MOE.gguf",
      generationPerSecond: 33.67032435745798,
      promptPerSecond: 60.663047104856076,
      contextTokens: 42,
    });
    expect(Number.isFinite(s.ttftMs)).toBe(true);
    expect(s.ttftMs).toBeGreaterThanOrEqual(0);
    // The throughput mean still sees the same completion.
    expect(client.measuredTokensPerSecond()).toBe(33.67032435745798);
  });

  it("records a unary completion without a first-token time", async () => {
    const { client } = clientWith([unaryOk]);
    await client.complete({ prompt: "p" });
    expect(client.performanceSamples()).toEqual([
      expect.objectContaining({ streamed: false, ttftMs: null, concurrent: 1 }),
    ]);
  });

  it("hands out a copy of the samples", async () => {
    const { client } = clientWith([unaryOk]);
    await client.complete({ prompt: "p" });
    client.performanceSamples().pop();
    expect(client.performanceSamples()).toHaveLength(1);
  });

  it("records nothing for a completion without timings", async () => {
    const { client } = clientWith([() => json({ content: "x", stop: true })]);
    await client.complete({ prompt: "p" });
    expect(client.performanceSamples()).toEqual([]);
  });

  it("counts two overlapping streams as two", async () => {
    const { client } = clientWith([ok]);
    const a = client.completeStream({ prompt: "a" });
    const b = client.completeStream({ prompt: "b" });
    expect((await a.next()).value).toMatchObject({ delta: "hi" });
    expect((await b.next()).value).toMatchObject({ delta: "hi" });
    await drain(a);
    await drain(b);
    expect(client.performanceSamples().map((s) => s.concurrent)).toEqual([2, 2]);
    await expectNothingLeftOpen(client);
  });

  it("counts a unary call that overlaps a stream on both", async () => {
    const { client } = clientWith([ok, unaryOk, ok]);
    const stream = client.completeStream({ prompt: "a" });
    expect((await stream.next()).value).toMatchObject({ delta: "hi" });
    await client.complete({ prompt: "b" });
    await drain(stream);
    const samples = client.performanceSamples();
    expect(samples.map((s) => [s.streamed, s.concurrent])).toEqual([
      [false, 2],
      [true, 2],
    ]);
    await expectNothingLeftOpen(client);
  });

  it("counts a retried stream once and includes the backoff in its first-token time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const slept: number[] = [];
    const { client, calls } = clientWith([unavailable, ok], {
      retries: 3,
      backoffMs: 400,
      sleep: async (ms) => {
        slept.push(ms);
        vi.setSystemTime(Date.now() + ms);
      },
    });
    await drain(client.completeStream({ prompt: "p" }));
    expect(calls()).toBe(2);
    expect(slept).toHaveLength(1);
    const samples = client.performanceSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]?.concurrent).toBe(1);
    expect(samples[0]?.ttftMs).toBeGreaterThanOrEqual(slept[0]!);
    vi.useRealTimers();
    await expectNothingLeftOpen(client);
  });

  it("counts a retried unary call once", async () => {
    const { client } = clientWith([unavailable, unaryOk], { retries: 3 });
    await client.complete({ prompt: "p" });
    expect(client.performanceSamples().map((s) => s.concurrent)).toEqual([1]);
  });

  it("records nothing when the retries run out", async () => {
    const { client } = clientWith([unavailable, unavailable, ok], { retries: 2 });
    await expect(drain(client.completeStream({ prompt: "p" }))).rejects.toThrow();
    expect(client.performanceSamples()).toEqual([]);
    await expectNothingLeftOpen(client);
  });

  it("records nothing for an HTTP 500, streamed or unary", async () => {
    const { client } = clientWith([
      () => new Response("boom", { status: 500 }),
      () => new Response("boom", { status: 500 }),
      ok,
    ]);
    await expect(drain(client.completeStream({ prompt: "p" }))).rejects.toThrow();
    await expect(client.complete({ prompt: "p" })).rejects.toThrow();
    expect(client.performanceSamples()).toEqual([]);
    await expectNothingLeftOpen(client);
  });

  it("records nothing for a call aborted before its first byte", async () => {
    const hang: Reply = (init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    const { client } = clientWith([hang, ok]);
    const abort = new AbortController();
    const stream = client.completeStream({ prompt: "p", signal: abort.signal });
    const pending = stream.next();
    await Promise.resolve();
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect(client.performanceSamples()).toEqual([]);
    await expectNothingLeftOpen(client);
  });

  it("records nothing for a call aborted during the backoff", async () => {
    const abort = new AbortController();
    const { client } = clientWith([unavailable, ok], {
      retries: 3,
      sleep: async () => abort.abort(),
    });
    await expect(
      drain(client.completeStream({ prompt: "p", signal: abort.signal })),
    ).rejects.toThrow();
    const unary = new AbortController();
    const second = clientWith([unavailable, unaryOk], {
      retries: 3,
      sleep: async () => unary.abort(),
    });
    await expect(second.client.complete({ prompt: "p", signal: unary.signal })).rejects.toThrow();
    expect(client.performanceSamples()).toEqual([]);
    expect(second.client.performanceSamples()).toEqual([]);
    await expectNothingLeftOpen(client);
  });

  it("records nothing when the transport fails after the stop event", async () => {
    const { client } = clientWith([() => sse([DELTA, STOP], "error"), ok]);
    const stream = client.completeStream({ prompt: "p" });
    let next = await stream.next();
    while (!next.done && !next.value.done) next = await stream.next();
    expect(next.value).toMatchObject({ done: true });
    await expect(stream.next()).rejects.toThrow();
    expect(client.performanceSamples()).toEqual([]);
    await expectNothingLeftOpen(client);
  });

  it("records nothing when the consumer walks away after the done chunk", async () => {
    const { client } = clientWith([ok]);
    const stream = client.completeStream({ prompt: "p" });
    let next = await stream.next();
    while (!next.done && !next.value.done) next = await stream.next();
    expect(next.value).toMatchObject({ done: true });
    await stream.return(undefined as never);
    expect(client.performanceSamples()).toEqual([]);
    await expectNothingLeftOpen(client);
  });

  it("records nothing for a stream that ends without a stop event", async () => {
    const { client } = clientWith([() => sse([DELTA]), ok]);
    await drain(client.completeStream({ prompt: "p" }));
    expect(client.performanceSamples()).toEqual([]);
    await expectNothingLeftOpen(client);
  });

  it("has no first-token time for a stream with no delta before its stop", async () => {
    const { client } = clientWith([() => sse([STOP])]);
    await drain(client.completeStream({ prompt: "p" }));
    expect(client.performanceSamples()).toEqual([
      expect.objectContaining({ streamed: true, ttftMs: null, concurrent: 1 }),
    ]);
  });
});
