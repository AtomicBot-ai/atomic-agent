import { describe, expect, it } from "vitest";

import {
  HEARTBEAT_CHECKLIST_MAX_CHARS,
  HEARTBEAT_MIN_INTERVAL_MS,
  HEARTBEAT_SENTINEL,
  buildHeartbeatPrompt,
  clampHeartbeatIntervalMs,
  heartbeatTaskMessage,
  isHeartbeatSilent,
  isWithinActiveHours,
  parseActiveHours,
} from "./task-heartbeat.js";

/** Local wall-clock time today, for the active-hours checks. */
function at(hh: number, mm: number): Date {
  const d = new Date(2026, 10, 12, hh, mm, 0, 0);
  return d;
}

describe("isHeartbeatSilent", () => {
  it.each([
    "NO_REPLY",
    "  NO_REPLY  \n",
    "no_reply",
    "**NO_REPLY**",
    "`NO_REPLY`.",
    "\"NO_REPLY\"",
    "",
    "   ",
  ])("treats %j as nothing new", (reply) => {
    expect(isHeartbeatSilent(reply)).toBe(true);
  });

  it("treats a run without a reply as nothing new", () => {
    expect(isHeartbeatSilent(null)).toBe(true);
    expect(isHeartbeatSilent(undefined)).toBe(true);
  });

  it.each([
    "The deploy failed at 10:02.",
    "NO_REPLY is what I would say, but the build is red.",
    "XNO_REPLY",
    "NO_REPLY_YET",
    "Two new issues were filed.",
    "Build failed on main. Otherwise NO_REPLY",
    "Checked mail and the build. Nothing new.\nNO_REPLY",
    "Nothing changed: NO_REPLY",
  ])("delivers %j", (reply) => {
    expect(isHeartbeatSilent(reply)).toBe(false);
  });
});

describe("clampHeartbeatIntervalMs", () => {
  it("raises an interval under the floor to it", () => {
    expect(clampHeartbeatIntervalMs(60_000)).toEqual({
      everyMs: HEARTBEAT_MIN_INTERVAL_MS,
      clamped: true,
    });
    expect(clampHeartbeatIntervalMs(Number.NaN).everyMs).toBe(HEARTBEAT_MIN_INTERVAL_MS);
  });

  it("keeps an interval at or over the floor", () => {
    expect(clampHeartbeatIntervalMs(HEARTBEAT_MIN_INTERVAL_MS)).toEqual({
      everyMs: HEARTBEAT_MIN_INTERVAL_MS,
      clamped: false,
    });
    expect(clampHeartbeatIntervalMs(3_600_000)).toEqual({ everyMs: 3_600_000, clamped: false });
  });
});

describe("active hours", () => {
  it("parses a window, no window, and refuses a typo", () => {
    expect(parseActiveHours("08:00-22:00")).toEqual({ start: "08:00", end: "22:00" });
    expect(parseActiveHours(undefined)).toBeNull();
    expect(parseActiveHours("8am-10pm")).toBe("invalid");
  });

  it("runs only inside a daytime window", () => {
    const hours = { start: "08:00", end: "22:00" };
    expect(isWithinActiveHours(hours, at(8, 0))).toBe(true);
    expect(isWithinActiveHours(hours, at(21, 59))).toBe(true);
    expect(isWithinActiveHours(hours, at(22, 0))).toBe(false);
    expect(isWithinActiveHours(hours, at(3, 0))).toBe(false);
  });

  it("handles a window across midnight", () => {
    const hours = { start: "22:00", end: "02:00" };
    expect(isWithinActiveHours(hours, at(23, 30))).toBe(true);
    expect(isWithinActiveHours(hours, at(1, 0))).toBe(true);
    expect(isWithinActiveHours(hours, at(12, 0))).toBe(false);
  });

  it("runs around the clock without a window or with an equal start and end", () => {
    expect(isWithinActiveHours(null, at(3, 0))).toBe(true);
    expect(isWithinActiveHours({ start: "09:00", end: "09:00" }, at(3, 0))).toBe(true);
  });
});

describe("buildHeartbeatPrompt", () => {
  it("carries the checklist and the silence rule", () => {
    const prompt = buildHeartbeatPrompt({
      checklistPath: "/state/HEARTBEAT.md",
      checklist: "- check the build\n- check new issues\n",
      at: at(9, 0),
    });
    expect(prompt).toContain("- check the build\n- check new issues");
    expect(prompt).toContain(`reply with exactly ${HEARTBEAT_SENTINEL}`);
    expect(prompt).toContain("/state/HEARTBEAT.md");
  });

  it("cuts a very long checklist", () => {
    const prompt = buildHeartbeatPrompt({
      checklistPath: "/x",
      checklist: "a".repeat(HEARTBEAT_CHECKLIST_MAX_CHARS + 500),
      at: at(9, 0),
    });
    expect(prompt).toContain("[checklist cut here]");
    expect(prompt.length).toBeLessThan(16_000);
  });

  it("stores a short readable message on the task row", () => {
    expect(heartbeatTaskMessage("/state/HEARTBEAT.md")).toBe(
      "Heartbeat check: go through the checklist in /state/HEARTBEAT.md",
    );
  });
});
