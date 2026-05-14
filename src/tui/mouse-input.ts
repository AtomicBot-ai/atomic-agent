/**
 * Minimal SGR (1006) mouse-event listener for the Ink TUI. Toggles the
 * terminal into mouse-tracking mode for the duration of the agent
 * lifetime and exposes:
 *
 *   - `installMouseInput` — owns the stdin → (mouse events + cleaned
 *     bytes) split. The listener consumes `process.stdin` exclusively
 *     and re-pushes the **non-mouse** portion of every chunk into a
 *     proxy stream that Ink reads from. Without this split the SGR
 *     escape (`\x1b[<64;71;26M`) leaks into Ink's keypress parser and
 *     ends up dumped into the editor as literal text — which is
 *     exactly what `installMouseInput` v1 did wrong.
 *   - `parseMouseEvents` / `extractMouseEvents` — pure parsers that
 *     unit tests pin separately.
 *
 * Sequences enabled at install time:
 *   `\x1b[?1000h`  basic mouse-button tracking
 *   `\x1b[?1006h`  SGR-style coordinates (no 95-col limit)
 *
 * Mouse wheel maps to button 64 (up) and 65 (down) in SGR.
 */
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";

const ENABLE_BASIC = "\u001B[?1000h";
const ENABLE_SGR = "\u001B[?1006h";
const DISABLE_BASIC = "\u001B[?1000l";
const DISABLE_SGR = "\u001B[?1006l";

export type MouseEvent = {
  type: "wheel_up" | "wheel_down";
  col: number;
  row: number;
};

export interface MouseInputController {
  /** Stop listening + restore the terminal mouse mode. Idempotent. */
  stop(): void;
  /**
   * Filtered stdin proxy that should be passed to Ink's `render(...,
   * { stdin })`. Behaves like `process.stdin` (proxies `isTTY` and
   * `setRawMode`) but only emits **non-mouse** bytes. When mouse mode
   * is not installed (no TTY), this is `process.stdin` itself so the
   * caller can pass it unconditionally.
   */
  stdin: NodeJS.ReadStream;
}

export interface MouseInputOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  onEvent: (event: MouseEvent) => void;
}

/**
 * Installs the mouse listener and returns a filtered stdin proxy.
 * When the target streams are not TTYs (piped output, CI), the
 * function is a silent no-op and `stdin` falls back to the source
 * stream unchanged — the caller can wire `controller.stdin` into Ink
 * unconditionally.
 */
export function installMouseInput(
  options: MouseInputOptions,
): MouseInputController {
  const source = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (!streamIsTty(stdout) || !streamIsTty(source)) {
    return { stop: () => {}, stdin: source };
  }
  stdout.write(ENABLE_BASIC);
  stdout.write(ENABLE_SGR);
  const proxy = createTtyProxyStream(source);
  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const { events, cleaned } = extractMouseEvents(text);
    for (const event of events) options.onEvent(event);
    if (cleaned.length > 0) proxy.push(cleaned);
  };
  source.on("data", onData);
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    source.off("data", onData);
    stdout.write(DISABLE_SGR);
    stdout.write(DISABLE_BASIC);
    proxy.push(null);
  };
  const onExit = (): void => stop();
  process.once("exit", onExit);
  return {
    stop: () => {
      process.off("exit", onExit);
      stop();
    },
    stdin: proxy as unknown as NodeJS.ReadStream,
  };
}

/**
 * Wraps `source` (typically `process.stdin`) in a `PassThrough` that
 * proxies the TTY-specific methods Ink relies on (`isTTY`,
 * `setRawMode`, `ref` / `unref`). The body of the stream is fed by
 * the mouse listener; reading directly from this proxy without first
 * installing the listener will block forever — that is intentional
 * and matches the construction order in `installMouseInput`.
 */
function createTtyProxyStream(source: NodeJS.ReadStream): PassThrough {
  const proxy = new PassThrough({ encoding: "utf8" });
  Object.defineProperties(proxy, {
    isTTY: { get: () => Boolean(source.isTTY), configurable: true },
    setRawMode: {
      value(mode: boolean) {
        source.setRawMode?.(mode);
        return proxy;
      },
      configurable: true,
    },
    ref: {
      value() {
        source.ref?.();
        return proxy;
      },
      configurable: true,
    },
    unref: {
      value() {
        source.unref?.();
        return proxy;
      },
      configurable: true,
    },
  });
  return proxy;
}

const SGR_PATTERN = /\u001B\[<(\d+);(\d+);(\d+)([Mm])/g;

/**
 * Pure parser for an SGR mouse-event stream. Exposed for unit tests
 * separately from `extractMouseEvents`; the latter additionally
 * returns the input minus the matched escape sequences for the
 * stdin-fork path.
 */
export function parseMouseEvents(text: string): MouseEvent[] {
  return extractMouseEvents(text).events;
}

export interface MouseExtractionResult {
  events: MouseEvent[];
  /**
   * Input text with every recognised SGR mouse sequence removed
   * (whether wheel, click, drag, or release). What's left is safe to
   * forward to Ink's keypress parser as ordinary input.
   */
  cleaned: string;
}

/**
 * Strips every SGR mouse escape sequence from `text` and returns the
 * remainder alongside the parsed wheel events. Click / drag / release
 * events are filtered out (no event emitted) but their bytes are
 * still removed from `cleaned` — keeping them would let raw click
 * coordinates leak into the editor identical to the original bug.
 */
export function extractMouseEvents(text: string): MouseExtractionResult {
  const events: MouseEvent[] = [];
  let cleaned = "";
  let lastIndex = 0;
  SGR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_PATTERN.exec(text)) !== null) {
    cleaned += text.slice(lastIndex, match.index);
    lastIndex = match.index + match[0].length;
    const buttonRaw = Number.parseInt(match[1] ?? "", 10);
    const col = Number.parseInt(match[2] ?? "", 10);
    const row = Number.parseInt(match[3] ?? "", 10);
    const action = match[4];
    if (Number.isNaN(buttonRaw) || Number.isNaN(col) || Number.isNaN(row)) {
      continue;
    }
    if (action !== "M") continue;
    if (buttonRaw === 64) {
      events.push({ type: "wheel_up", col, row });
      continue;
    }
    if (buttonRaw === 65) {
      events.push({ type: "wheel_down", col, row });
      continue;
    }
  }
  cleaned += text.slice(lastIndex);
  return { events, cleaned };
}

function streamIsTty(stream: Readable | Writable | undefined): boolean {
  return Boolean((stream as NodeJS.ReadStream | NodeJS.WriteStream | undefined)?.isTTY);
}
