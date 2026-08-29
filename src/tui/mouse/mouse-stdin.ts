/**
 * Keyboard/mouse demultiplexer for the TUI's stdin.
 *
 * Ink parses stdin as keystrokes and has no mouse layer, so a raw mouse
 * report reaching it is decoded as a stray Escape plus a handful of
 * literal characters typed into the chat buffer. Rather than fight that
 * downstream, we hand Ink a *different* stream: this module reads the
 * real TTY, pulls the mouse reports out, and forwards everything else
 * to a `PassThrough` that Ink treats as its stdin.
 *
 * The wrapper has to look enough like `process.stdin` for Ink's raw
 * mode plumbing — `isTTY`, `setRawMode`, `ref`/`unref` — so those are
 * delegated to the real stream. Ink also `unshift()`s bytes back during
 * its kitty-keyboard probe; a `PassThrough` supports that natively.
 */
import { PassThrough } from "node:stream";
import { decodeMouseEvents } from "./parse-mouse-events.js";
import type { TuiMouseEvent } from "./mouse-event.js";

export interface MouseStdin {
  /** Stream to hand to Ink's `render({ stdin })` — mouse bytes removed. */
  readonly stdin: NodeJS.ReadStream;
  /** Detaches from the real stdin. Call during TUI teardown. */
  dispose(): void;
}

/**
 * Wraps `source` so mouse reports are delivered to `onMouseEvent` and
 * every other byte flows through to the returned stream.
 */
export function createMouseStdin(
  source: NodeJS.ReadStream,
  onMouseEvent: (event: TuiMouseEvent) => void,
): MouseStdin {
  const passthrough = new PassThrough();
  // Ink asks its stdin for raw mode and for TTY-ness; both questions
  // are really about the underlying terminal, so proxy them.
  const proxy = passthrough as unknown as NodeJS.ReadStream;
  Object.defineProperty(proxy, "isTTY", {
    configurable: true,
    get: () => source.isTTY,
  });
  Object.defineProperty(proxy, "isRaw", {
    configurable: true,
    get: () => source.isRaw,
  });
  proxy.setRawMode = (mode: boolean): NodeJS.ReadStream => {
    source.setRawMode?.(mode);
    return proxy;
  };
  // `ref`/`unref` are TTY/socket concerns — a PassThrough has neither,
  // so they belong to the real stdin and only to it.
  proxy.ref = (): NodeJS.ReadStream => {
    source.ref?.();
    return proxy;
  };
  proxy.unref = (): NodeJS.ReadStream => {
    source.unref?.();
    return proxy;
  };

  // A report can straddle two reads; `pending` holds the head of a
  // truncated sequence until the rest of it arrives.
  let pending = "";
  const onData = (chunk: Buffer | string): void => {
    const decoded = decodeMouseEvents(
      pending + (typeof chunk === "string" ? chunk : chunk.toString("utf8")),
    );
    pending = decoded.rest;
    for (const event of decoded.events) onMouseEvent(event);
    if (decoded.text.length > 0) passthrough.write(decoded.text);
  };
  source.on("data", onData);

  return {
    stdin: proxy,
    dispose: () => {
      source.off("data", onData);
      pending = "";
    },
  };
}
