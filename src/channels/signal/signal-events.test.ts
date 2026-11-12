import { describe, expect, it, vi } from "vitest";

import { SignalEventStream, SseParser, type SseEvent } from "./signal-events.js";

/** An SSE response whose body is `chunks`, then closes. */
function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const refused = () =>
  Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

describe("SseParser", () => {
  it("assembles events across arbitrary chunk boundaries", () => {
    const events: SseEvent[] = [];
    const parser = new SseParser((e) => events.push(e));
    parser.push("event: rece");
    parser.push('ive\nid: 7\ndata: {"a":');
    parser.push("1}\n\n: keep-alive\n\r\ndata: x\r\n\r\n");
    expect(events).toEqual([
      { event: "receive", data: '{"a":1}', id: "7" },
      { event: "message", data: "x", id: "7" },
    ]);
  });
});

describe("SignalEventStream", () => {
  it("reports a refused connection as down with the daemon url and retries", async () => {
    const onDown = vi.fn();
    const fetch = vi.fn(async () => {
      throw refused();
    });
    const stream = new SignalEventStream({
      url: "http://127.0.0.1:8080",
      fetch,
      onPayload: vi.fn(),
      onUp: vi.fn(),
      onDown,
      backoff: () => 1,
    });
    await stream.start();
    expect(onDown).toHaveBeenCalledWith(
      "signal-cli daemon not reachable at http://127.0.0.1:8080 (ECONNREFUSED)",
    );
    await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2));
    stream.stop();
  });

  it("dispatches JSON payloads and resumes with Last-Event-ID", async () => {
    const payloads: unknown[] = [];
    const onUp = vi.fn();
    let call = 0;
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
      call++;
      if (call === 1) return sse(['id: 41\nevent: receive\ndata: {"envelope":{"n":1}}\n\n', "data: not json\n\n"]);
      return new Promise<Response>(() => {});
    });
    const stream = new SignalEventStream({
      url: "http://d",
      fetch,
      onPayload: (p) => payloads.push(p),
      onUp,
      onDown: vi.fn(),
      backoff: () => 1,
    });
    await stream.start();
    expect(onUp).toHaveBeenCalled();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(payloads).toEqual([{ envelope: { n: 1 } }]);
    const headers = (fetch.mock.calls[1]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["last-event-id"]).toBe("41");
    stream.stop();
  });

  it("stops retrying after stop()", async () => {
    const fetch = vi.fn(async () => {
      throw refused();
    });
    const stream = new SignalEventStream({
      url: "http://d",
      fetch,
      onPayload: vi.fn(),
      onUp: vi.fn(),
      onDown: vi.fn(),
      backoff: () => 5,
    });
    await stream.start();
    stream.stop();
    stream.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
