import { afterEach, describe, expect, it, vi } from "vitest";
import { LlamaServerClient } from "./llama-server-client.js";
import type {
  CompletionResult,
  PromptProgress,
  StreamChunk,
} from "./provider/completion-types.js";

// ATO-1027: prompt-evaluation progress on a streamed completion. Its own
// file: the main client suite is already past the size budget.

const encoder = new TextEncoder();

function progressEvent(processed: number, total: number, cache = 0): string {
  return `data: ${JSON.stringify({
    content: "",
    stop: false,
    prompt_progress: { total, cache, processed, time_ms: processed },
  })}\n\n`;
}

function streamingClient(options: {
  requestTimeoutMs?: number;
  firstTokenTimeoutMs?: number;
} = {}): {
  client: LlamaServerClient;
  bodies: Array<Record<string, unknown>>;
  push: (text: string) => void;
  close: () => void;
} {
  const bodies: Array<Record<string, unknown>> = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const client = new LlamaServerClient({
    baseUrl: "http://127.0.0.1:9999",
    progressWatch: false,
    requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
    firstTokenTimeoutMs: options.firstTokenTimeoutMs ?? 60_000,
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            // A real fetch body dies with its request's signal.
            init?.signal?.addEventListener("abort", () => {
              try {
                c.error(new DOMException("This operation was aborted", "AbortError"));
              } catch {
                // already closed
              }
            });
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch,
  });
  return {
    client,
    bodies,
    push: (text) => controller?.enqueue(encoder.encode(text)),
    close: () => controller?.close(),
  };
}

async function drain(
  iterator: AsyncGenerator<StreamChunk, CompletionResult, void>,
): Promise<{ chunks: StreamChunk[]; final: CompletionResult }> {
  const chunks: StreamChunk[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return { chunks, final: next.value };
    chunks.push(next.value);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LlamaServerClient prompt progress (ATO-1027)", () => {
  it("asks for return_progress only when someone listens", async () => {
    const quiet = streamingClient();
    const plain = quiet.client.completeStream({ prompt: "hi" });
    const plainDone = drain(plain);
    await vi.waitFor(() => expect(quiet.bodies).toHaveLength(1));
    quiet.push('data: {"content":"ok","stop":true}\n\n');
    quiet.close();
    await plainDone;
    expect(quiet.bodies[0]).not.toHaveProperty("return_progress");

    const listened = streamingClient();
    const stream = listened.client.completeStream({
      prompt: "hi",
      onPromptProgress: () => undefined,
    });
    const done = drain(stream);
    await vi.waitFor(() => expect(listened.bodies).toHaveLength(1));
    listened.push('data: {"content":"ok","stop":true}\n\n');
    listened.close();
    await done;
    expect(listened.bodies[0]).toMatchObject({ return_progress: true });
  });

  it("reports progress to the listener and never yields it as a chunk", async () => {
    const seen: PromptProgress[] = [];
    const { client, bodies, push, close } = streamingClient();
    const done = drain(
      client.completeStream({ prompt: "hi", onPromptProgress: (p) => seen.push(p) }),
    );
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    push(progressEvent(512, 2048, 256) + progressEvent(2048, 2048, 256));
    push('data: {"content":"hello","stop":false}\n\n');
    push('data: {"content":"","stop":true}\n\n');
    close();
    const { chunks, final } = await done;

    expect(seen).toEqual([
      { processed: 512, total: 2048, cached: 256, elapsedMs: 512 },
      { processed: 2048, total: 2048, cached: 256, elapsedMs: 2048 },
    ]);
    // The first chunk is the reply: the fallback chain reads the first
    // yielded chunk as "this link is serving".
    expect(chunks[0]).toEqual({ delta: "hello", reasoningDelta: "", done: false });
    expect(chunks.every((c) => c.delta.length > 0 || c.done)).toBe(true);
    expect(final.content).toBe("hello");
  });

  it("keeps the first-token budget while only progress arrives", async () => {
    // Idle budget 1 s, first-token budget 5 s. Were progress read as the
    // reply starting, the stream would move to the idle budget and die
    // at 1 s of prompt evaluation between two progress frames.
    vi.useFakeTimers();
    const { client, bodies, push, close } = streamingClient({
      requestTimeoutMs: 1_000,
      firstTokenTimeoutMs: 5_000,
    });
    let failed: unknown = null;
    const done = drain(
      client.completeStream({ prompt: "hi", onPromptProgress: () => undefined }),
    ).catch((err: unknown) => {
      failed = err;
      return null;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies).toHaveLength(1);
    push(progressEvent(100, 1000));
    await vi.advanceTimersByTimeAsync(1_500);
    push(progressEvent(900, 1000));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(failed).toBeNull();
    push('data: {"content":"ok","stop":true}\n\n');
    close();
    await vi.advanceTimersByTimeAsync(0);
    const result = await done;
    expect(failed).toBeNull();
    expect(result?.final.content).toBe("ok");
  });

  it("keeps the first-token budget when a progress frame is split across reads", async () => {
    // Half a frame completes no event. Read as the reply starting, it
    // moved the stream to the idle budget and stopped the /slots watch,
    // and the progress frames after it never put the first-token budget
    // back: a long first prompt read died at the idle budget.
    vi.useFakeTimers();
    const { client, bodies, push, close } = streamingClient({
      requestTimeoutMs: 1_000,
      firstTokenTimeoutMs: 10_000,
    });
    const seen: PromptProgress[] = [];
    let failed: unknown = null;
    const done = drain(
      client.completeStream({ prompt: "hi", onPromptProgress: (p) => seen.push(p) }),
    ).catch((err: unknown) => {
      failed = err;
      return null;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies).toHaveLength(1);
    const frame = progressEvent(100, 1000);
    push(frame.slice(0, 20));
    await vi.advanceTimersByTimeAsync(500);
    push(frame.slice(20));
    await vi.advanceTimersByTimeAsync(500);
    push(progressEvent(500, 1000));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(failed).toBeNull();
    push(progressEvent(1000, 1000));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(failed).toBeNull();
    push('data: {"content":"ok","stop":true}\n\n');
    close();
    await vi.advanceTimersByTimeAsync(0);
    const result = await done;
    expect(failed).toBeNull();
    expect(seen.map((p) => p.processed)).toEqual([100, 500, 1000]);
    expect(result?.final.content).toBe("ok");
  });

  it("still ends a prompt evaluation at the first-token budget", async () => {
    vi.useFakeTimers();
    const { client, bodies, push } = streamingClient({
      requestTimeoutMs: 1_000,
      firstTokenTimeoutMs: 2_000,
    });
    const failure = drain(
      client.completeStream({ prompt: "hi", onPromptProgress: () => undefined }),
    ).then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies).toHaveLength(1);
    push(progressEvent(100, 1000));
    await vi.advanceTimersByTimeAsync(2_001);
    const err = (await failure) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("sent no first token within 2000ms");
  });
});
