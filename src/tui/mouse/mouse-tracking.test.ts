import { describe, expect, it } from "vitest";
import {
  resetTerminalRestoreForTests,
  restoreTerminalNow,
} from "../terminal-restore.js";
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

const ENABLE_TRACKING = "\u001B[?1002h";
const DISABLE_TRACKING = "\u001B[?1002l";
const ENABLE_SGR = "\u001B[?1006h";
const DISABLE_SGR = "\u001B[?1006l";

describe("enableMouseTracking", () => {
  it("requests button tracking with SGR reports on a TTY", () => {
    const stdout = makeStdout(true);
    enableMouseTracking({ stdout: stdout as unknown as NodeJS.WriteStream });
    expect(stdout.writes).toEqual([ENABLE_TRACKING, ENABLE_SGR]);
  });

  it("asks for button-event tracking but never any-motion", () => {
    // 1002 reports motion only while a button is held, which is what
    // drag-to-select in the composer needs. 1003 reports every pointer
    // movement — a constant stream of wakeups, and the hit test walks
    // the layout tree per event. Nothing here hovers.
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    const enabling = stdout.writes.join("");
    expect(enabling).toContain("1002");
    expect(enabling).not.toContain("1003");
    controller.disable();
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

  it("leaves reporting off when the process dies without a teardown", () => {
    // The net in `terminal-restore.ts` is what a crash reaches; the
    // assertion is on the sequences the terminal ends up with, not on
    // which process event carried them.
    resetTerminalRestoreForTests();
    const stdout = makeStdout(true);
    enableMouseTracking({ stdout: stdout as unknown as NodeJS.WriteStream });
    restoreTerminalNow();
    expect(stdout.writes).toEqual([
      ENABLE_TRACKING,
      ENABLE_SGR,
      DISABLE_SGR,
      DISABLE_TRACKING,
    ]);
  });

  it("takes itself out of the net when disabled explicitly", () => {
    resetTerminalRestoreForTests();
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.disable();
    const afterDisable = stdout.writes.length;
    restoreTerminalNow();
    expect(stdout.writes).toHaveLength(afterDisable);
  });

  it("suspend hands selection back without retiring the controller", () => {
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    expect(controller.isSuspended()).toBe(false);
    controller.suspend();
    expect(controller.isSuspended()).toBe(true);
    expect(stdout.writes).toEqual([
      ENABLE_TRACKING,
      ENABLE_SGR,
      DISABLE_SGR,
      DISABLE_TRACKING,
    ]);
  });

  it("resume turns reporting back on in enable order", () => {
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.suspend();
    controller.resume();
    expect(controller.isSuspended()).toBe(false);
    expect(stdout.writes.slice(4)).toEqual([ENABLE_TRACKING, ENABLE_SGR]);
  });

  it("suspend and resume are idempotent", () => {
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.resume();
    expect(stdout.writes).toHaveLength(2);
    controller.suspend();
    controller.suspend();
    expect(stdout.writes).toHaveLength(4);
    controller.resume();
    controller.resume();
    expect(stdout.writes).toHaveLength(6);
  });

  it("disable while suspended writes nothing more — the terminal is already clean", () => {
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.suspend();
    controller.disable();
    // The suspend already sent the disable pair; the sequence the
    // terminal saw last is a clean disable either way.
    expect(stdout.writes).toEqual([
      ENABLE_TRACKING,
      ENABLE_SGR,
      DISABLE_SGR,
      DISABLE_TRACKING,
    ]);
    expect(controller.isSuspended()).toBe(false);
  });

  it("suspend and resume are no-ops after disable", () => {
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.disable();
    const afterDisable = stdout.writes.length;
    controller.suspend();
    controller.resume();
    expect(controller.isSuspended()).toBe(false);
    expect(stdout.writes).toHaveLength(afterDisable);
  });

  it("crash restore during a suspension adds no extra writes", () => {
    resetTerminalRestoreForTests();
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.suspend();
    restoreTerminalNow();
    expect(stdout.writes).toEqual([
      ENABLE_TRACKING,
      ENABLE_SGR,
      DISABLE_SGR,
      DISABLE_TRACKING,
    ]);
  });

  it("non-TTY controller never reports suspended", () => {
    const stdout = makeStdout(false);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.suspend();
    expect(controller.isSuspended()).toBe(false);
    controller.resume();
    expect(stdout.writes).toEqual([]);
  });
});
