import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  registerTerminalRestore,
  resetTerminalRestoreForTests,
  restoreTerminalNow,
} from "./terminal-restore.js";

beforeEach(() => resetTerminalRestoreForTests());
afterEach(() => resetTerminalRestoreForTests());

describe("terminal restore net", () => {
  it("runs restores LIFO so modes unwind in the order they were entered", () => {
    const order: string[] = [];
    registerTerminalRestore(() => order.push("alt-screen"));
    registerTerminalRestore(() => order.push("mouse"));
    restoreTerminalNow();
    // Mouse reporting is turned on last and must be turned off first —
    // the reverse would leave the terminal on the normal screen while
    // still reporting clicks into the shell.
    expect(order).toEqual(["mouse", "alt-screen"]);
  });

  it("drains the registry so a later exit hook cannot restore twice", () => {
    let calls = 0;
    registerTerminalRestore(() => {
      calls += 1;
    });
    restoreTerminalNow();
    restoreTerminalNow();
    expect(calls).toBe(1);
  });

  it("keeps going when one restore throws", () => {
    const done: string[] = [];
    registerTerminalRestore(() => done.push("outer"));
    registerTerminalRestore(() => {
      throw new Error("stdout closed");
    });
    expect(() => restoreTerminalNow()).not.toThrow();
    expect(done).toEqual(["outer"]);
  });

  it("unregistering takes a restore back out of the net", () => {
    let calls = 0;
    const unregister = registerTerminalRestore(() => {
      calls += 1;
    });
    unregister();
    restoreTerminalNow();
    expect(calls).toBe(0);
  });

  it("installs its process hooks exactly once across registrations", () => {
    const beforeExit = process.listenerCount("exit");
    const beforeUncaught = process.listenerCount("uncaughtException");
    registerTerminalRestore(() => {});
    registerTerminalRestore(() => {});
    registerTerminalRestore(() => {});
    expect(process.listenerCount("exit")).toBe(beforeExit + 1);
    expect(process.listenerCount("uncaughtException")).toBe(beforeUncaught + 1);
  });

  it("hands the terminal back before the crash reporter's handler runs", () => {
    // The reporter (`error-reporting/error-reporter.ts`) prints the
    // stack and flushes Sentry for up to two seconds. Both want a
    // terminal that has already left the alt screen, so the restore is
    // *prepended* — this test pins the ordering rather than the fact
    // that a listener exists.
    const seen: string[] = [];
    const reporter = (): void => {
      seen.push("reporter");
    };
    process.on("uncaughtException", reporter);
    try {
      registerTerminalRestore(() => seen.push("restore"));
      const handlers = process.listeners("uncaughtException");
      for (const handler of handlers) handler(new Error("boom"), "uncaughtException");
    } finally {
      process.off("uncaughtException", reporter);
    }
    expect(seen).toEqual(["restore", "reporter"]);
  });
});
