import { describe, expect, it } from "vitest";

import { buildLogbookQuery, describeWindow, formatLogbookEntries, parseClock, parseDaySpec, selectLogbookEntries } from "./logbook-query.js";
import type { LogbookEntry } from "./logbook-store.js";

const NOW = new Date(2026, 10, 27, 16, 0);

function at(hour: number, minute: number, text: string, app = "Safari"): LogbookEntry {
  return { at: new Date(2026, 10, 26, hour, minute).toISOString(), app, bundleId: null, text };
}

describe("logbook query", () => {
  it("reads today, yesterday and dates", () => {
    expect(parseDaySpec(undefined, NOW)).toBe("2026-11-27");
    expect(parseDaySpec("Yesterday", NOW)).toBe("2026-11-26");
    expect(parseDaySpec("2026-11-01", NOW)).toBe("2026-11-01");
    expect(() => parseDaySpec("last week", NOW)).toThrow(/today, yesterday/);
  });

  it("reads clock times", () => {
    expect(parseClock("09:30", "from")).toBe(570);
    expect(parseClock("24:00", "to")).toBe(1440);
    expect(() => parseClock("25:00", "to")).toThrow(/not a time/);
    expect(() => parseClock("9", "from")).toThrow(/not a time/);
  });

  it("turns 'yesterday afternoon' into a 12:00 to 18:00 window", () => {
    const query = buildLogbookQuery({ day: "yesterday", part: "afternoon" }, NOW);
    expect(query).toMatchObject({ day: "2026-11-26", fromMinute: 720, toMinute: 1080, contains: null });
    expect(describeWindow(query)).toBe("2026-11-26 12:00-18:00");
    expect(() => buildLogbookQuery({ part: "night" }, NOW)).toThrow(/morning, afternoon or evening/);
    expect(() => buildLogbookQuery({ from: "15:00", to: "14:00" }, NOW)).toThrow(/later/);
  });

  it("selects the window and the words, in time order", () => {
    const entries = [at(17, 0, "Reviewing PR 12"), at(9, 0, "Mail"), at(13, 15, "Writing the logbook spec", "Notes")];
    const afternoon = selectLogbookEntries(entries, buildLogbookQuery({ day: "yesterday", part: "afternoon" }, NOW));
    expect(afternoon.map((e) => e.text)).toEqual(["Writing the logbook spec", "Reviewing PR 12"]);
    const notes = selectLogbookEntries(entries, buildLogbookQuery({ day: "yesterday", contains: "notes" }, NOW));
    expect(notes.map((e) => e.text)).toEqual(["Writing the logbook spec"]);
    expect(formatLogbookEntries(afternoon)).toBe("13:15  Notes  Writing the logbook spec\n17:00  Safari  Reviewing PR 12");
  });

  it("samples evenly over the limit so the whole window stays covered", () => {
    const entries = Array.from({ length: 10 }, (_, i) => at(8 + i, 0, `hour ${8 + i}`));
    const picked = selectLogbookEntries(entries, buildLogbookQuery({ day: "yesterday", limit: 5 }, NOW));
    expect(picked.map((e) => e.text)).toEqual(["hour 8", "hour 10", "hour 12", "hour 14", "hour 16"]);
  });
});
