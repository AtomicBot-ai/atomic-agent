import { describe, expect, it } from "vitest";
import { enableMouseTracking } from "./mouse-tracking.js";

interface FakeStdout {
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
  };
}

const ENABLE_TRACKING = "\u001B[?1000h";
const DISABLE_TRACKING = "\u001B[?1000l";
const ENABLE_SGR = "\u001B[?1006h";
const DISABLE_SGR = "\u001B[?1006l";

describe("enableMouseTracking", () => {
  it("requests button tracking with SGR reports on a TTY", () => {
    const stdout = makeStdout(true);
    enableMouseTracking({ stdout: stdout as unknown as NodeJS.WriteStream });
    expect(stdout.writes).toEqual([ENABLE_TRACKING, ENABLE_SGR]);
  });

  it("never asks for motion tracking", () => {
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.disable();
    expect(stdout.writes.join("")).not.toContain("1002");
    expect(stdout.writes.join("")).not.toContain("1003");
  });

  it("hands selection back to the terminal on disable", () => {
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.disable();
    expect(stdout.writes).toEqual([
      ENABLE_TRACKING,
      ENABLE_SGR,
      DISABLE_SGR,
      DISABLE_TRACKING,
    ]);
  });

  it("is idempotent — a second disable writes nothing", () => {
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.disable();
    controller.disable();
    expect(stdout.writes).toHaveLength(4);
  });

  it("is a no-op when stdout is not a TTY", () => {
    const stdout = makeStdout(false);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.disable();
    expect(stdout.writes).toEqual([]);
  });

  it("detaches its exit hook when disabled explicitly", () => {
    const before = process.listenerCount("exit");
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    expect(process.listenerCount("exit")).toBe(before + 1);
    controller.disable();
    expect(process.listenerCount("exit")).toBe(before);
  });
});
