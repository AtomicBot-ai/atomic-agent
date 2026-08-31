import { describe, expect, it } from "vitest";

import { readTerminalSize } from "./use-terminal-size.js";

const tty = (columns: number, rows: number): NodeJS.WriteStream =>
  ({ columns, rows, isTTY: true }) as unknown as NodeJS.WriteStream;

describe("readTerminalSize", () => {
  it("reports the raw TTY size on a modern host", () => {
    expect(readTerminalSize(tty(120, 40), false)).toEqual({
      columns: 120,
      rows: 40,
    });
  });

  it("reserves the bottom row on a legacy conhost TTY", () => {
    // The frame is pinned to `height={rows}`; on the frozen Win10
    // conhost a frame that touches the bottom terminal row scrolls the
    // viewport — the duplicated-last-row / shaking report. One reserved
    // row keeps every frame strictly above the scroll trigger.
    expect(readTerminalSize(tty(120, 40), true)).toEqual({
      columns: 120,
      rows: 39,
    });
  });

  it("leaves non-TTY streams alone even when detection says conhost", () => {
    const piped = {
      columns: 100,
      rows: 30,
      isTTY: false,
    } as unknown as NodeJS.WriteStream;
    expect(readTerminalSize(piped, true)).toEqual({ columns: 100, rows: 30 });
  });

  it("falls back to 80x24 without a stream, guard or not", () => {
    expect(readTerminalSize(undefined, false)).toEqual({
      columns: 80,
      rows: 24,
    });
    // No stream means no TTY, so the guard cannot apply either.
    expect(readTerminalSize(undefined, true)).toEqual({
      columns: 80,
      rows: 24,
    });
  });

  it("does not let the guard report a zero-height terminal", () => {
    expect(readTerminalSize(tty(80, 1), true)).toEqual({
      columns: 80,
      rows: 1,
    });
  });
});
