import { describe, expect, it } from "vitest";

import { applyLogbookAction, parseLogbookAction } from "./logbook-actions.js";
import { DEFAULT_LOGBOOK_SETTINGS, type LogbookSettings } from "./logbook-settings.js";
import { logbookPlatformSupport, logbookState } from "./logbook-view.js";

const T0 = 1_800_000_000_000;
const MAC = logbookPlatformSupport("darwin", {});
const off: LogbookSettings = { ...DEFAULT_LOGBOOK_SETTINGS, excludeApps: [] };
const on: LogbookSettings = { ...off, enabled: true };

describe("logbook actions (ATO-2534)", () => {
  it("parses the four verbs and refuses anything else", () => {
    expect(parseLogbookAction({ action: "stop" })).toEqual({ kind: "stop" });
    expect(parseLogbookAction({ action: "resume" })).toEqual({ kind: "resume" });
    expect(parseLogbookAction({ action: "pause" })).toEqual({ kind: "pause", minutes: 60 });
    expect(parseLogbookAction({ action: "pause", minutes: 30 })).toEqual({ kind: "pause", minutes: 30 });
    expect(parseLogbookAction({ action: "pause", minutes: 0 })).toBeNull();
    expect(parseLogbookAction({ action: "pause", minutes: 2000 })).toBeNull();
    expect(parseLogbookAction({ action: "delete" })).toBeNull();
    expect(parseLogbookAction(null)).toBeNull();
  });

  it("pauses for the given minutes and resumes", () => {
    const paused = applyLogbookAction(on, { kind: "pause", minutes: 30 }, T0, MAC);
    expect(paused).toEqual({ ok: true, settings: { ...on, pausedUntil: T0 + 30 * 60_000 } });
    if (!paused.ok) return;
    expect(logbookState(paused.settings, T0 + 1)).toBe("paused");
    const resumed = applyLogbookAction(paused.settings, { kind: "resume" }, T0 + 2, MAC);
    expect(resumed.ok && resumed.settings.pausedUntil).toBeNull();
  });

  it("stops and clears a pause, keeping the other settings", () => {
    const result = applyLogbookAction({ ...on, pausedUntil: T0, excludeApps: ["Slack"] }, { kind: "stop" }, T0, MAC);
    expect(result).toEqual({ ok: true, settings: { ...on, enabled: false, pausedUntil: null, excludeApps: ["Slack"] } });
  });

  it("will not pause a logbook that is off", () => {
    expect(applyLogbookAction(off, { kind: "pause", minutes: 10 }, T0, MAC).ok).toBe(false);
  });

  it("starts only where the computer can run it", () => {
    expect(applyLogbookAction(off, { kind: "start" }, T0, MAC)).toMatchObject({ ok: true, settings: { enabled: true } });
    // ATO-2526: Windows and Linux on X11 run it; Wayland cannot say which window is in front.
    expect(applyLogbookAction(off, { kind: "start" }, T0, logbookPlatformSupport("win32", {})).ok).toBe(true);
    expect(applyLogbookAction(off, { kind: "start" }, T0, logbookPlatformSupport("linux", { DISPLAY: ":0" })).ok).toBe(true);
    const refused = applyLogbookAction(off, { kind: "start" }, T0, logbookPlatformSupport("linux", { WAYLAND_DISPLAY: "wayland-0" }));
    expect(refused).toMatchObject({ ok: false, message: expect.stringMatching(/Wayland/) });
  });
});
