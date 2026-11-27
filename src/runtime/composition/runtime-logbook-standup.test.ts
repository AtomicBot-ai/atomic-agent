import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_LOGBOOK_SETTINGS, readStandupState, writeLogbookSettings } from "../../logbook/index.js";
import { createStandupCheck, standupMessage, standupTasks } from "./runtime-logbook-standup.js";

/** ATO-2526: the morning standup goes through the task runner as one cron task. */
describe("logbook standup through the scheduler", () => {
  it("files a cron task in the person's time zone with the standup recipe for yesterday", () => {
    const create = vi.fn(() => ({ id: "t1" }));
    const api = standupTasks({ runner: { create, cancel: vi.fn() } as never, store: { get: () => null } as never }, "Europe/Berlin");
    expect(api.createDaily("0 9 * * *", standupMessage())).toBe("t1");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      origin: "sidecar",
      schedule: { kind: "cron", expression: "0 9 * * *", tz: "Europe/Berlin" },
      userMessage: expect.stringMatching(/yesterday/),
    }));
    expect(api.isLive("t1")).toBe(false);
  });

  it("checks at most once a minute and files the task when the settings ask for it", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "atomic-standup-check-"));
    writeLogbookSettings(stateDir, { ...DEFAULT_LOGBOOK_SETTINGS, excludeApps: [], titleOnlyApps: [], enabled: true, standupAt: "09:00" });
    const create = vi.fn(() => ({ id: "t1" }));
    const check = createStandupCheck({
      stateDir,
      tasks: { runner: { create, cancel: vi.fn() } as never, store: { get: () => ({ status: "pending" }) } as never },
      logger: { warn: vi.fn() },
      timeZone: "UTC",
    });
    check(1_000);
    check(2_000);
    expect(create).toHaveBeenCalledTimes(1);
    expect(readStandupState(stateDir)).toEqual({ taskId: "t1", at: "09:00" });
  });
});
