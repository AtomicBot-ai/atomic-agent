import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { captureError, guardStdioStream } from "./error-reporter.js";
import type { GuardedStream } from "./error-reporter.js";
import type { SentryClient } from "./sentry-client.js";
import type { ScrubbedErrorEvent } from "./error-scrubber.js";

function fakeClient() {
  const captured: ScrubbedErrorEvent[] = [];
  const client = {
    capture: vi.fn((ev: ScrubbedErrorEvent) => captured.push(ev)),
  } as unknown as SentryClient;
  return { client, captured };
}

describe("captureError", () => {
  it("no-ops when the client is null", () => {
    expect(() =>
      captureError(null, new Error("x"), { source: "s" }),
    ).not.toThrow();
  });

  it("drops cancelled failures", () => {
    const { client, captured } = fakeClient();
    const err = Object.assign(new Error("aborted"), {
      name: "CancelledError",
      category: "cancelled",
    });
    captureError(client, err, { source: "llm_failure", category: "cancelled" });
    expect(captured).toHaveLength(0);
  });

  it("captures a real error via the scrubber", () => {
    const { client, captured } = fakeClient();
    const err = Object.assign(new Error("transport boom"), {
      name: "TransportError",
      category: "transport",
      status: 500,
    });
    captureError(client, err, { source: "llm_failure" });
    expect(captured).toHaveLength(1);
    expect(captured[0].errorType).toBe("TransportError");
    expect(captured[0].category).toBe("transport");
    expect(captured[0].message).toBeUndefined();
  });

  it("reports a non-Error thrown value as NonError without stringifying it", () => {
    const { client, captured } = fakeClient();
    // A thrown string could contain user data — it must never be sent.
    captureError(client, "/Users/alex/secret prompt text", {
      source: "uncaughtException",
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].errorType).toBe("NonError");
    expect(captured[0].message).toBeUndefined();
  });
  it("drops a process-global broken pipe — the reader left, nothing broke", () => {
    const { client, captured } = fakeClient();
    const err = Object.assign(new Error("write EPIPE"), {
      code: "EPIPE",
      syscall: "write",
    });
    captureError(client, err, { source: "uncaughtException" });
    expect(captured).toHaveLength(0);
  });

  it("still reports an EPIPE raised at a call site, where it may be ours", () => {
    const { client, captured } = fakeClient();
    const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    captureError(client, err, { source: "tool_exec" });
    expect(captured).toHaveLength(1);
  });
});

/** A stdio stream as far as the guard can tell: events, and a write that records. */
function fakeStdio() {
  const written: string[] = [];
  const stream = Object.assign(new EventEmitter(), {
    write: vi.fn((chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk));
      const callback = rest.find((r) => typeof r === "function") as
        | (() => void)
        | undefined;
      callback?.();
      return true;
    }),
  });
  return { stream: stream as unknown as GuardedStream, emitter: stream, written };
}

const brokenPipe = () =>
  Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" });

describe("guardStdioStream", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 0 on a broken pipe by default, when the process is its own", () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const { stream, emitter } = fakeStdio();
    guardStdioStream(stream, true, "exit");
    emitter.emit("error", brokenPipe());
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("only swallows a broken pipe in a process a host owns", () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const { stream, emitter } = fakeStdio();
    guardStdioStream(stream, false, "exit");
    emitter.emit("error", brokenPipe());
    expect(exit).not.toHaveBeenCalled();
  });

  // serve: a host that died must not end the server before its teardown.
  it("under mute, stops writing to the broken stream and does not exit", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const { stream, emitter, written } = fakeStdio();
    guardStdioStream(stream, true, "mute");
    stream.write("before\n");
    emitter.emit("error", brokenPipe());
    expect(exit).not.toHaveBeenCalled();

    // Later writes are dropped, and a caller waiting on one still hears back.
    const done = vi.fn();
    expect(stream.write("after\n", done)).toBe(true);
    stream.write("after again\n", "utf8", done);
    await new Promise((resolve) => process.nextTick(resolve));
    expect(written).toEqual(["before\n"]);
    expect(done).toHaveBeenCalledTimes(2);

    // A second broken-pipe report changes nothing.
    emitter.emit("error", brokenPipe());
    expect(exit).not.toHaveBeenCalled();
  });
});
