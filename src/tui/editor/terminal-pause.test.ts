import { describe, expect, it, vi } from "vitest";
import type { MouseTrackingController } from "../mouse/mouse-tracking.js";
import { createTerminalPause } from "./terminal-pause.js";

interface FakeStdin {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn<(mode: boolean) => void>>;
}

function fakeStdin(isRaw = true): FakeStdin {
  const stdin: FakeStdin = {
    isTTY: true,
    isRaw,
    setRawMode: vi.fn<(mode: boolean) => void>(),
  };
  stdin.setRawMode.mockImplementation((mode) => {
    stdin.isRaw = mode;
  });
  return stdin;
}

function fakeStdout(isTTY = true) {
  const writes: string[] = [];
  return { isTTY, writes, write: (chunk: string) => writes.push(chunk) };
}

function fakeMouse(suspended = false): MouseTrackingController {
  let paused = suspended;
  return {
    disable: vi.fn(),
    suspend: vi.fn(() => {
      paused = true;
    }),
    resume: vi.fn(() => {
      paused = false;
    }),
    isSuspended: () => paused,
  };
}

describe("createTerminalPause", () => {
  it("releases raw mode, mouse, kitty and the alt screen, then puts them back", () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const mouse = fakeMouse();
    const pause = createTerminalPause({ stdin, stdout, kittyKeyboard: true, mouse: () => mouse });

    pause.suspend();
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(mouse.suspend).toHaveBeenCalledTimes(1);
    const out = stdout.writes.join("");
    expect(out).toContain("\u001B[<u");
    expect(out).toContain("\u001B[?1049l");
    expect(out).toContain("\u001B[?25h");

    stdout.writes.length = 0;
    pause.resume();
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(true);
    expect(mouse.resume).toHaveBeenCalledTimes(1);
    const back = stdout.writes.join("");
    expect(back).toContain("\u001B[?1049h");
    expect(back).toContain("\u001B[2J\u001B[H");
    expect(back).toContain("\u001B[>1u");
  });

  it("leaves the kitty protocol alone when Ink never enabled it", () => {
    const stdout = fakeStdout();
    const pause = createTerminalPause({ stdin: fakeStdin(), stdout, kittyKeyboard: false, mouse: () => null });
    pause.suspend();
    pause.resume();
    expect(stdout.writes.join("")).not.toMatch(/\u001B\[[<>]1?u/);
  });

  it("does not resume a mouse the selection passthrough had already paused", () => {
    const mouse = fakeMouse(true);
    const pause = createTerminalPause({ stdin: fakeStdin(), stdout: fakeStdout(), kittyKeyboard: false, mouse: () => mouse });
    pause.suspend();
    pause.resume();
    expect(mouse.suspend).not.toHaveBeenCalled();
    expect(mouse.resume).not.toHaveBeenCalled();
  });

  it("re-enters raw mode only if it was on", () => {
    const stdin = fakeStdin(false);
    const pause = createTerminalPause({ stdin, stdout: fakeStdout(), kittyKeyboard: false, mouse: () => null });
    pause.suspend();
    pause.resume();
    expect(stdin.setRawMode).not.toHaveBeenCalled();
  });

  it("writes nothing to a stdout that is not a terminal", () => {
    const stdout = fakeStdout(false);
    const pause = createTerminalPause({ stdin: fakeStdin(), stdout, kittyKeyboard: true, mouse: () => null });
    pause.suspend();
    pause.resume();
    expect(stdout.writes).toEqual([]);
  });
});
