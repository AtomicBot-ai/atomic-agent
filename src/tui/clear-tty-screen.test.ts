import { describe, expect, it } from "vitest";
import { clearTtyScreen } from "./clear-tty-screen.js";

interface FakeStdout extends NodeJS.WriteStream {
  isTTY: boolean;
  writes: string[];
  write(chunk: string): boolean;
}

function makeStdout(isTty: boolean): FakeStdout {
  const writes: string[] = [];
  return {
    isTTY: isTty,
    writes,
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
  } as FakeStdout;
}

describe("clearTtyScreen", () => {
  it("writes clear + home on a TTY", () => {
    const stdout = makeStdout(true);
    clearTtyScreen(stdout);
    expect(stdout.writes).toEqual(["\u001B[2J\u001B[H"]);
  });

  it("is a no-op when stdout is not a TTY", () => {
    const stdout = makeStdout(false);
    clearTtyScreen(stdout);
    expect(stdout.writes).toEqual([]);
  });
});
