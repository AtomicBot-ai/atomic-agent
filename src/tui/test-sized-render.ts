import { EventEmitter } from "node:events";
import { render as inkRender } from "ink";
import type { ReactElement } from "react";

/**
 * Render an Ink tree into a fake terminal of a chosen size.
 *
 * `ink-testing-library` pins its fake stdout at 100 columns and reports
 * no `rows` at all, so every frame it produces is the same 100×24
 * terminal once `useTerminalSize` falls back — one size can never
 * exercise a layout's tiers. This helper is that library's render with
 * the two numbers made real: the layout hooks read them, and Ink wraps
 * at the width they claim.
 */
class SizedStdout extends EventEmitter {
  readonly columns: number;
  readonly rows: number;
  private last: string | undefined;

  constructor(size: { columns: number; rows: number }) {
    super();
    this.columns = size.columns;
    this.rows = size.rows;
  }

  write = (frame: string): boolean => {
    this.last = frame;
    return true;
  };

  lastFrame = (): string | undefined => this.last;
}

/** The same silent no-op stdin the testing library fakes. */
class SizedStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;

  write = (data: string): void => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}

  read = (): string | null => {
    const { data } = this;
    this.data = null;
    return data;
  };
}

export interface SizedRenderResult {
  lastFrame(): string | undefined;
  stdin: { write(data: string): void };
  rerender(tree: ReactElement): void;
  unmount(): void;
}

export function renderAtSize(
  tree: ReactElement,
  size: { columns: number; rows: number },
): SizedRenderResult {
  const stdout = new SizedStdout(size);
  const stderr = new SizedStdout(size);
  const stdin = new SizedStdin();
  const instance = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    // `debug` makes every commit write the whole frame, so `lastFrame`
    // is the full screen rather than a log-update diff.
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    lastFrame: stdout.lastFrame,
    stdin,
    rerender: instance.rerender,
    unmount: instance.unmount,
  };
}
