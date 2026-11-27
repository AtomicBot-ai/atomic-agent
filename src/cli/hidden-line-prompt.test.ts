import { describe, expect, it, vi } from "vitest";
import { PassThrough, Readable } from "node:stream";

import { isRawModeTerminal, readHiddenLine, type RawModeInput } from "./hidden-line-prompt.js";

/** A stand-in for `process.stdin` on a terminal: a stream with `isTTY` and `setRawMode`. */
function fakeTerminal(): PassThrough & RawModeInput & { setRawMode: ReturnType<typeof vi.fn> } {
  const input = new PassThrough() as PassThrough & RawModeInput & { setRawMode: ReturnType<typeof vi.fn> };
  input.isTTY = true;
  input.setRawMode = vi.fn(() => input);
  return input;
}

function fakeOutput() {
  const written: string[] = [];
  return { written, write: (chunk: string) => written.push(chunk) };
}

describe("readHiddenLine (ATO-2756)", () => {
  it("prints the prompt, turns echo off while reading and restores it", async () => {
    const input = fakeTerminal();
    const output = fakeOutput();
    const line = readHiddenLine(input, output, "Paste: ");
    input.write("sk-live-1\r");
    expect(await line).toBe("sk-live-1");
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    // Only the prompt and the closing newline: the value is never echoed.
    expect(output.written).toEqual(["Paste: ", "\n"]);
  });

  it("handles backspace, a paste split over chunks and stray escape sequences", async () => {
    const input = fakeTerminal();
    const line = readHiddenLine(input, fakeOutput(), "> ");
    input.write("sk-ab");
    input.write("x\u007f");
    input.write("\u001b[Dc\n");
    expect(await line).toBe("sk-abc");
  });

  it("resolves null on Ctrl+C", async () => {
    const input = fakeTerminal();
    const line = readHiddenLine(input, fakeOutput(), "> ");
    input.write("half\u0003");
    expect(await line).toBeNull();
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("tells a terminal from a pipe", () => {
    expect(isRawModeTerminal(fakeTerminal())).toBe(true);
    expect(isRawModeTerminal(Readable.from(["x"]))).toBe(false);
  });
});
