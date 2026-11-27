import { describe, expect, it } from "vitest";

import { applyLogbookPreferences, hasPreferences, parseLogbookPreferences } from "./logbook-preferences.js";
import { DEFAULT_LOGBOOK_SETTINGS } from "./logbook-settings.js";

/** ATO-2526: what the desktop's Settings, Logbook sends. */
describe("logbook preferences", () => {
  const base = { ...DEFAULT_LOGBOOK_SETTINGS, excludeApps: ["Slack"], titleOnlyApps: [] };

  it("keeps what is left out and cleans what is sent like settings.json", () => {
    const parsed = parseLogbookPreferences({ intervalMinutes: 500, titleOnlyApps: [" Mail "], standupAt: "08:15" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(applyLogbookPreferences(base, parsed.preferences)).toEqual({ ...base, intervalMinutes: 60, titleOnlyApps: ["Mail"], standupAt: "08:15" });
  });

  it("turns the standup off with null", () => {
    const parsed = parseLogbookPreferences({ standupAt: null });
    expect(parsed).toEqual({ ok: true, preferences: { standupAt: null } });
  });

  it("refuses bad values with the field named", () => {
    expect(parseLogbookPreferences({ standupAt: "9am" })).toMatchObject({ ok: false, field: "standupAt" });
    expect(parseLogbookPreferences({ excludeApps: "Slack" })).toMatchObject({ ok: false, field: "excludeApps" });
    expect(parseLogbookPreferences({ retentionDays: "7" })).toMatchObject({ ok: false, field: "retentionDays" });
  });

  it("tells a preference body from an action body", () => {
    expect(hasPreferences({ action: "stop" })).toBe(false);
    expect(hasPreferences({ standupAt: null })).toBe(true);
  });
});
