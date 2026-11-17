import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import {
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
} from "../tasks/index.js";

import { formatHeartbeatLine, parseHeartbeatCreateArgs } from "./task-heartbeat-command.js";

const defaults = { stateDir: resolve("/state"), cwd: resolve("/work") };

describe("parseHeartbeatCreateArgs", () => {
  it("defaults to 30 minutes, the state dir checklist, no window and no target", () => {
    expect(parseHeartbeatCreateArgs([], defaults)).toEqual({
      everyMs: HEARTBEAT_DEFAULT_INTERVAL_MS,
      clamped: false,
      checklistPath: resolve("/state", "HEARTBEAT.md"),
      activeHours: null,
      telegram: false,
      osNotify: false,
    });
  });

  it("raises an interval under five minutes and says so", () => {
    const parsed = parseHeartbeatCreateArgs(["--every", "1m"], defaults);
    expect(parsed).toMatchObject({ everyMs: HEARTBEAT_MIN_INTERVAL_MS, clamped: true });
  });

  it("reads the interval, checklist, window, targets and session", () => {
    const parsed = parseHeartbeatCreateArgs(
      [
        "--every", "1h",
        "--checklist", "notes/HEARTBEAT.md",
        "--active-hours", "08:00-22:00",
        "--notify", "telegram,os",
        "--session", "s-1",
      ],
      defaults,
    );
    expect(parsed).toEqual({
      everyMs: 3_600_000,
      clamped: false,
      checklistPath: resolve("/work", "notes/HEARTBEAT.md"),
      activeHours: { start: "08:00", end: "22:00" },
      telegram: true,
      osNotify: true,
      sessionId: "s-1",
    });
  });

  it.each([
    [["--every", "soon"], /--every/],
    [["--active-hours", "8-22"], /--active-hours/],
    [["--notify", "email"], /--notify/],
  ])("refuses %j", (args, message) => {
    const parsed = parseHeartbeatCreateArgs(args, defaults);
    expect("error" in parsed && parsed.error).toMatch(message);
  });
});

describe("formatHeartbeatLine", () => {
  const base = {
    taskId: "t-1",
    checklistPath: "/state/HEARTBEAT.md",
    activeHours: null,
    osNotify: false,
  };

  it("shows a silent run as nothing new", () => {
    const line = formatHeartbeatLine(
      { ...base, lastOutcome: "nothing_new", lastCheckedAt: Date.UTC(2026, 10, 12, 9, 0) },
      "pending",
      null,
    );
    expect(line).toContain("nothing new at 2026-11-12T09:00:00.000Z");
    expect(line).toContain("t-1 pending");
  });

  it("shows a heartbeat that has not run yet", () => {
    const line = formatHeartbeatLine({ ...base, lastOutcome: null, lastCheckedAt: null }, "pending", null);
    expect(line).toContain("not checked yet");
  });
});
