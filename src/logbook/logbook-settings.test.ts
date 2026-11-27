import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOGBOOK_SETTINGS,
  logbookCapturing,
  logbookDir,
  parseLogbookSettings,
  readLogbookSettings,
  writeLogbookSettings,
} from "./logbook-settings.js";

const tempState = () => mkdtempSync(join(tmpdir(), "atomic-logbook-settings-"));

describe("logbook settings", () => {
  it("is off by default: no file, a broken file and a non-object all read as off", () => {
    const dir = tempState();
    expect(readLogbookSettings(dir)).toEqual({ ...DEFAULT_LOGBOOK_SETTINGS, excludeApps: [] });
    mkdirSync(logbookDir(dir), { recursive: true });
    writeFileSync(join(logbookDir(dir), "settings.json"), "{ not json");
    expect(readLogbookSettings(dir).enabled).toBe(false);
    expect(parseLogbookSettings([1, 2]).enabled).toBe(false);
    expect(parseLogbookSettings({ enabled: "yes" }).enabled).toBe(false);
  });

  it("clamps the interval and the retention and drops bad excluded apps", () => {
    const parsed = parseLogbookSettings({
      enabled: true,
      intervalMinutes: 0.2,
      retentionDays: 9000,
      pausedUntil: -5,
      excludeApps: ["  Slack ", "", 42, "x".repeat(300)],
    });
    expect(parsed).toEqual({ enabled: true, intervalMinutes: 1, retentionDays: 365, pausedUntil: null, excludeApps: ["Slack"] });
    expect(parseLogbookSettings({ intervalMinutes: 500 }).intervalMinutes).toBe(60);
    expect(parseLogbookSettings({ intervalMinutes: Number.NaN }).intervalMinutes).toBe(5);
  });

  it("writes owner-only and reads back what it wrote", () => {
    const dir = tempState();
    writeLogbookSettings(dir, { enabled: true, intervalMinutes: 10, retentionDays: 3, pausedUntil: 123, excludeApps: ["com.tinyspeck.slackmacgap"] });
    expect(readLogbookSettings(dir)).toEqual({ enabled: true, intervalMinutes: 10, retentionDays: 3, pausedUntil: 123, excludeApps: ["com.tinyspeck.slackmacgap"] });
    const file = join(logbookDir(dir), "settings.json");
    expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(logbookDir(dir)).mode & 0o777).toBe(0o700);
    }
  });

  it("captures only while on and outside a pause", () => {
    const on = { ...DEFAULT_LOGBOOK_SETTINGS, excludeApps: [], enabled: true };
    expect(logbookCapturing(on, 1_000)).toBe(true);
    expect(logbookCapturing({ ...on, enabled: false }, 1_000)).toBe(false);
    expect(logbookCapturing({ ...on, pausedUntil: 2_000 }, 1_000)).toBe(false);
    expect(logbookCapturing({ ...on, pausedUntil: 2_000 }, 2_000)).toBe(true);
  });
});
