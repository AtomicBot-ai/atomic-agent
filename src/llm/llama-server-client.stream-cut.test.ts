import { describe, expect, it } from "vitest";
import { LlamaServerClient, LlamaServerError, parseSseErrorEvent } from "./llama-server-client.js";

/**
 * ATO-1279: a stream the server cuts after answering is marked
 * `midStream`, so the agent loop can retry the step once. A failure
 * before the body opened, our own deadline and the caller's abort are
 * not marked.
 */
function fetchReturning(make: () => Response): typeof fetch {
  return (async () => make()) as unknown as typeof fetch;
}

function streamOf(chunks: string[], failWith?: Error): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (failWith !== undefined) controller.error(failWith);
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function drain(client: LlamaServerClient, signal?: AbortSignal): Promise<unknown> {
  try {
    const iterator = client.completeStream({ prompt: "hi", ...(signal ? { signal } : {}) });
    while (!(await iterator.next()).done) {
      // keep reading
    }
    return null;
  } catch (err) {
    return err;
  }
}

describe("parseSseErrorEvent", () => {
  it("reads llama.cpp's `error:` event and a data payload carrying `error`", () => {
    expect(
      parseSseErrorEvent('error: {"code":500,"message":"failed to decode","type":"server_error"}'),
    ).toEqual({ status: 500, detail: "failed to decode", type: "server_error" });
    expect(
      parseSseErrorEvent('data: {"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}'),
    ).toEqual({ status: 503, detail: "Loading model", type: "unavailable_error" });
    expect(parseSseErrorEvent('data: {"error":"boom"}')).toEqual({ status: 500, detail: "boom" });
    expect(
      parseSseErrorEvent('data: {"error":{"code":400,"message":"too long","type":"exceed_context_size_error"}}'),
    ).toEqual({ status: 400, detail: "too long", type: "exceed_context_size_error" });
  });

  it("is null for ordinary events", () => {
    expect(parseSseErrorEvent('data: {"content":"hi","stop":false}')).toBeNull();
    expect(parseSseErrorEvent("data: [DONE]")).toBeNull();
    expect(parseSseErrorEvent(": keep-alive")).toBeNull();
  });
});

describe("LlamaServerClient.completeStream: a cut stream (ATO-1279)", () => {
  it("throws a mid-stream 500 for an error event inside the stream instead of ending empty", async () => {
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      progressWatch: false,
      fetchImpl: fetchReturning(() =>
        streamOf([
          'data: {"content":"hel","stop":false}\n\n',
          'error: {"code":500,"message":"failed to decode","type":"server_error"}\n\n',
        ]),
      ),
    });
    const err = await drain(client);
    expect(err).toBeInstanceOf(LlamaServerError);
    const failure = err as LlamaServerError;
    expect(failure.status).toBe(500);
    expect(failure.midStream).toBe(true);
    expect(failure.timedOut).toBe(false);
    expect(failure.body?.type).toBe("server_error");
  });

  it("marks a connection that breaks while the body is read", async () => {
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      progressWatch: false,
      fetchImpl: fetchReturning(() =>
        streamOf(['data: {"content":"hel","stop":false}\n\n'], new TypeError("terminated")),
      ),
    });
    const err = (await drain(client)) as LlamaServerError;
    expect(err).toBeInstanceOf(LlamaServerError);
    expect(err.status).toBeNull();
    expect(err.midStream).toBe(true);
    expect(err.message).toContain("terminated");
  });

  it("does not mark a failure on the open", async () => {
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      progressWatch: false,
      completionRetries: 0,
      fetchImpl: fetchReturning(() => new Response("boom", { status: 500 })),
    });
    const err = (await drain(client)) as LlamaServerError;
    expect(err).toBeInstanceOf(LlamaServerError);
    expect(err.status).toBe(500);
    expect(err.midStream).toBe(false);
  });

  it("does not mark the caller's abort", async () => {
    const controller = new AbortController();
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const client = new LlamaServerClient({
      baseUrl: "http://127.0.0.1:9999",
      progressWatch: false,
      fetchImpl: fetchReturning(() => {
        controller.abort();
        return streamOf(['data: {"content":"hel","stop":false}\n\n'], abortError);
      }),
    });
    const err = await drain(client, controller.signal);
    if (err instanceof LlamaServerError) expect(err.midStream).toBe(false);
  });
});
