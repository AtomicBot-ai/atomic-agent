import { describe, expect, it } from "vitest";

import { TERMINAL_APP_HINT, terminalAppHint } from "./terminal-app-hint.js";

describe("terminalAppHint", () => {
  it.each([
    "_curses.error: setupterm: could not find terminal",
    "Error opening terminal: unknown.",
    "_curses.error: cbreak() returned ERR",
    "ERROR Raw mode is not supported on the current process.stdin",
  ])("recognises a missing-terminal failure: %j", (stderr) => {
    expect(terminalAppHint("", stderr)).toBe(TERMINAL_APP_HINT);
  });

  it("stays quiet on ordinary failures", () => {
    expect(terminalAppHint("", "Traceback...\nZeroDivisionError: division by zero")).toBeUndefined();
    expect(terminalAppHint("3 passed, 1 failed", "")).toBeUndefined();
    // tty noise next to a real failure is not a terminal program.
    expect(
      terminalAppHint("", "stty: stdin isn't a terminal\nInappropriate ioctl for device\nAssertionError: 1 != 2"),
    ).toBeUndefined();
  });
});
