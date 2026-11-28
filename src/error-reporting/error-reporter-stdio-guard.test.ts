import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { guardStdioStream, type GuardedStream } from "./error-reporter.js";

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
