import { describe, expect, it } from "vitest";

import { ShellMonitorWakeRouter, type MonitorWake } from "./shell-monitor-wake.js";

/** ATO-2436: a frontend that shows the session is asked first, then the runtime's path. */

const WAKE: MonitorWake = {
  sessionId: "s1",
  jobId: 2,
  command: "npm run dev",
  lineCount: 1,
  exited: false,
  text: "[Monitor on background job 2 (npm run dev): 1 new line matched \"ready\".]",
};

describe("ShellMonitorWakeRouter", () => {
  it("has nothing to wake with until a frontend or the fallback is set", () => {
    const router = new ShellMonitorWakeRouter();
    expect(router.canWake()).toBe(false);
    expect(router.deliver(WAKE)).toBe(false);
    router.setFallback(() => true);
    expect(router.canWake()).toBe(true);
  });

  it("asks frontends first and the fallback only when none took it", () => {
    const router = new ShellMonitorWakeRouter();
    const calls: string[] = [];
    router.setFallback(() => {
      calls.push("fallback");
      return true;
    });
    const remove = router.addFrontend((wake) => {
      calls.push(`tui:${wake.sessionId}`);
      return wake.sessionId === "s1";
    });
    expect(router.deliver(WAKE)).toBe(true);
    expect(calls).toEqual(["tui:s1"]);
    expect(router.deliver({ ...WAKE, sessionId: "other" })).toBe(true);
    expect(calls).toEqual(["tui:s1", "tui:other", "fallback"]);
    remove();
    calls.length = 0;
    router.deliver(WAKE);
    expect(calls).toEqual(["fallback"]);
  });

  it("treats a handler that throws as one that took nothing", () => {
    const router = new ShellMonitorWakeRouter();
    router.addFrontend(() => {
      throw new Error("view gone");
    });
    let fellBack = false;
    router.setFallback(() => {
      fellBack = true;
      return true;
    });
    expect(router.deliver(WAKE)).toBe(true);
    expect(fellBack).toBe(true);
  });
});
