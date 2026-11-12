import { describe, expect, it } from "vitest";
import {
  currentBrowserScope,
  isAttendedTurn,
  resolveLaunchHeadless,
  runInBrowserScope,
} from "./browser-run-scope.js";

describe("who the browser works for (ATO-959)", () => {
  it("cron tasks, bridges and plain HTTP clients are unattended", () => {
    for (const origin of ["scheduler", "telegram", "discord", "http"]) {
      expect(isAttendedTurn(origin, undefined)).toBe(false);
    }
  });

  it("the TUI, the desktop and a terminal run are watched", () => {
    for (const origin of ["tui", "sidecar", "cli", undefined]) {
      expect(isAttendedTurn(origin, undefined)).toBe(true);
    }
    // The desktop's HTTP extensions client says so itself.
    expect(isAttendedTurn("http", true)).toBe(true);
  });

  it("auto launches headless only for an unattended turn; an explicit setting always wins", () => {
    const unattended = { sessionId: "s", attended: false };
    const attended = { sessionId: "s", attended: true };
    expect(resolveLaunchHeadless("auto", unattended)).toBe(true);
    expect(resolveLaunchHeadless("auto", attended)).toBe(false);
    expect(resolveLaunchHeadless("auto", undefined)).toBe(false);
    expect(resolveLaunchHeadless(true, attended)).toBe(true);
    expect(resolveLaunchHeadless(false, unattended)).toBe(false);
  });

  it("the scope follows the turn across awaits and ends with it", async () => {
    expect(currentBrowserScope()).toBeUndefined();
    const seen = await runInBrowserScope({ sessionId: "cron-1", attended: false }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentBrowserScope();
    });
    expect(seen).toEqual({ sessionId: "cron-1", attended: false });
    expect(currentBrowserScope()).toBeUndefined();
  });
});
