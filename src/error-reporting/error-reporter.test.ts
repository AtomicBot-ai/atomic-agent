import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureError,
  createUncaughtExceptionHandler,
  guardStdioStream,
} from "./error-reporter.js";
import { LOOPBACK_RESET_NOTE } from "./loopback-reset.js";
import type { LoopbackResetPolicy } from "./loopback-reset.js";
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

  it("drops Atomic Chat not running, also when wrapped (ATO-1278)", () => {
    const { client, captured } = fakeClient();
    const inner = Object.assign(new Error("Atomic Chat is not running."), {
      name: "AtomicChatNotRunningError",
    });
    captureError(client, inner, { source: "llm_failure", category: "transport" });
    const wrapped = new Error("turn failed", { cause: inner });
    captureError(client, wrapped, { source: "llm_failure", category: "transport" });
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

  // ATO-1735: a local model server restarting under a request.
  const loopbackReset = () =>
    Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      address: "127.0.0.1",
    });

  it("drops an unhandled rejection that is a loopback reset", () => {
    const { client, captured } = fakeClient();
    captureError(client, loopbackReset(), { source: "unhandledRejection" });
    expect(captured).toHaveLength(0);
  });

  // An uncaught one takes the fatal exit: the crash must stay visible.
  it("still reports an uncaught loopback reset, with the socket tags", () => {
    const { client, captured } = fakeClient();
    captureError(client, loopbackReset(), { source: "uncaughtException" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.socketTags).toEqual({
      socket_error_code: "ECONNRESET",
      socket_peer: "loopback",
      undici_frame: "no",
    });
  });

  it("still reports a loopback reset raised by a tool", () => {
    const { client, captured } = fakeClient();
    captureError(client, loopbackReset(), { source: "tool_exec" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.socketTags).toBeUndefined();
  });

  it("tags a global reset it cannot prove is loopback", () => {
    const { client, captured } = fakeClient();
    const err = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      syscall: "read",
    });
    captureError(client, err, { source: "unhandledRejection" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.socketTags).toEqual({
      socket_error_code: "ECONNRESET",
      socket_peer: "unknown",
      undici_frame: "no",
    });
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

// ATO-2767: a local llama-server restarting reset a socket under a
// request, and the uncaught error ended `atag serve` (exit 1).
describe("createUncaughtExceptionHandler: loopback reset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function harness(loopbackReset: LoopbackResetPolicy) {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { client, captured } = fakeClient();
    (client as unknown as { flush: () => Promise<boolean> }).flush = vi.fn(
      async () => true,
    );
    const handler = createUncaughtExceptionHandler(() => client, {
      soleUncaughtHandler: true,
      brokenPipe: "mute",
      loopbackReset,
    });
    return { handler, exit, stderr, captured };
  }

  /** Let the fatal path's flush settle, so its `exit(1)` has run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  const reset = (address: string) =>
    Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      address,
    });

  it("under survive, a loopback reset neither exits nor reports", async () => {
    const { handler, exit, stderr, captured } = harness("survive");
    handler(reset("127.0.0.1"));
    await settle();
    expect(exit).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
    const written = stderr.mock.calls.map((c) => String(c[0]));
    expect(written).toEqual([LOOPBACK_RESET_NOTE]);
  });

  it("under survive, a dead stderr does not turn the note into a crash", async () => {
    const { handler, exit, stderr, captured } = harness("survive");
    stderr.mockImplementation(() => {
      throw new Error("write EPIPE");
    });
    expect(() => handler(reset("::1"))).not.toThrow();
    await settle();
    expect(exit).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it("under survive, a reset from a remote peer still reports and exits 1", async () => {
    const { handler, exit, captured } = harness("survive");
    handler(reset("203.0.113.7"));
    await settle();
    expect(captured).toHaveLength(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("under survive, a reset it cannot prove is loopback still exits 1", async () => {
    const { handler, exit, captured } = harness("survive");
    handler(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    await settle();
    expect(captured).toHaveLength(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("by default (exit), a loopback reset still reports and exits 1", async () => {
    const { handler, exit, captured } = harness("exit");
    handler(reset("127.0.0.1"));
    await settle();
    expect(captured).toHaveLength(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
