import { describe, expect, it } from "vitest";

import { DEFAULT_LOGBOOK_SETTINGS } from "../../logbook/logbook-settings.js";
import { logbookChipLabel, logbookChipState } from "./logbook-chip.js";

const OFF = { ...DEFAULT_LOGBOOK_SETTINGS, excludeApps: [] };

describe("logbook chip", () => {
  it("shows a mark the whole time the logbook is on, and nothing when off", () => {
    expect(logbookChipLabel(logbookChipState(OFF, 0))).toBeNull();
    expect(logbookChipLabel(logbookChipState({ ...OFF, enabled: true }, 0))).toBe("● logbook");
  });

  it("says paused during a pause", () => {
    const paused = { ...OFF, enabled: true, pausedUntil: 10_000 };
    expect(logbookChipState(paused, 5_000)).toBe("paused");
    expect(logbookChipLabel("paused")).toBe("◌ logbook paused");
    expect(logbookChipState(paused, 10_000)).toBe("on");
  });
});
