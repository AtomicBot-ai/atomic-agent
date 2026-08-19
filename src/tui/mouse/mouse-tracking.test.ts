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

  it("hands selection back and takes it again across suspend/resume", () => {
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.suspend();
    expect(controller.isSuspended()).toBe(true);
    expect(stdout.writes.slice(2)).toEqual([DISABLE_SGR, DISABLE_TRACKING]);
    controller.resume();
    expect(controller.isSuspended()).toBe(false);
    expect(stdout.writes.slice(4)).toEqual([ENABLE_TRACKING, ENABLE_SGR]);
  });

  it("ignores a repeated suspend and a resume that was never suspended", () => {
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.resume();
    controller.suspend();
    controller.suspend();
    expect(stdout.writes).toHaveLength(4);
  });

  it("keeps the exit hook installed while suspended", () => {
    // A crash mid-selection must still leave a clean terminal, so the
    // safety net cannot be tied to the reporting state.
    const before = process.listenerCount("exit");
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.suspend();
    expect(process.listenerCount("exit")).toBe(before + 1);
    controller.disable();
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("does not re-write the disable pair when disabled while suspended", () => {
    // Reporting is already off; a second `1000l` would target modes the
    // terminal never re-enabled.
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.suspend();
    controller.disable();
    expect(stdout.writes).toEqual([
      ENABLE_TRACKING,
      ENABLE_SGR,
      DISABLE_SGR,
      DISABLE_TRACKING,
    ]);
  });

  it("refuses to resume after disable", () => {
    const stdout = makeStdout(true);
    const controller = enableMouseTracking({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.disable();
    controller.resume();
    controller.suspend();
    expect(stdout.writes).toHaveLength(4);
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
