import { appendFileSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_LOGBOOK_SETTINGS, logbookDir, writeLogbookSettings } from "./logbook-settings.js";
import {
  appendLogbookEntry,
  clearLogbookDays,
  clearLogbookRange,
  dayKey,
  dayKeyOffset,
  deleteLogbookEntries,
  listLogbookDays,
  logbookToolOffered,
  pruneLogbook,
  readLogbookDay,
  type LogbookEntry,
} from "./logbook-store.js";

const tempState = () => mkdtempSync(join(tmpdir(), "atomic-logbook-store-"));

function entry(year: number, month: number, day: number, hour: number, minute: number, text = "editing a doc"): LogbookEntry {
  return { at: new Date(year, month - 1, day, hour, minute).toISOString(), app: "TextEdit", bundleId: "com.apple.TextEdit", text };
}

describe("logbook store", () => {
  it("appends to one owner-only file per local day and reads it back in order", () => {
    const dir = tempState();
    appendLogbookEntry(dir, entry(2026, 11, 26, 9, 0, "first"));
    appendLogbookEntry(dir, entry(2026, 11, 26, 14, 30, "second"));
    appendLogbookEntry(dir, entry(2026, 11, 27, 10, 0, "next day"));
    expect(listLogbookDays(dir)).toEqual(["2026-11-26", "2026-11-27"]);
    expect(readLogbookDay(dir, "2026-11-26").map((e) => e.text)).toEqual(["first", "second"]);
    if (process.platform !== "win32") {
      expect(statSync(join(logbookDir(dir), "2026-11-26.jsonl")).mode & 0o777).toBe(0o600);
    }
  });

  it("skips broken lines and returns nothing for a missing day", () => {
    const dir = tempState();
    appendLogbookEntry(dir, entry(2026, 11, 26, 9, 0));
    appendFileSync(join(logbookDir(dir), "2026-11-26.jsonl"), "garbage\n{\"at\":\"nope\",\"text\":\"x\"}\n");
    expect(readLogbookDay(dir, "2026-11-26")).toHaveLength(1);
    expect(readLogbookDay(dir, "2026-11-20")).toEqual([]);
    expect(() => readLogbookDay(dir, "../../etc/passwd")).toThrow(/not a day/);
  });

  it("prunes days older than the retention window, today included in the count", () => {
    const dir = tempState();
    for (const d of [10, 20, 25, 26, 27]) appendLogbookEntry(dir, entry(2026, 11, d, 12, 0));
    const removed = pruneLogbook(dir, 3, new Date(2026, 10, 27, 15, 0));
    expect(removed).toEqual(["2026-11-10", "2026-11-20"]);
    expect(listLogbookDays(dir)).toEqual(["2026-11-25", "2026-11-26", "2026-11-27"]);
  });

  it("clears all days, one day or the days before a date", () => {
    const dir = tempState();
    for (const d of [24, 25, 26]) appendLogbookEntry(dir, entry(2026, 11, d, 12, 0));
    expect(clearLogbookDays(dir, { day: "2026-11-25" })).toEqual(["2026-11-25"]);
    expect(clearLogbookDays(dir, { before: "2026-11-26" })).toEqual(["2026-11-24"]);
    expect(clearLogbookDays(dir, { all: true })).toEqual(["2026-11-26"]);
    expect(listLogbookDays(dir)).toEqual([]);
  });

  it("deletes the entries of a time range and removes the file when it empties", () => {
    const dir = tempState();
    appendLogbookEntry(dir, entry(2026, 11, 26, 9, 0, "morning"));
    appendLogbookEntry(dir, entry(2026, 11, 26, 13, 0, "lunch"));
    appendLogbookEntry(dir, entry(2026, 11, 26, 17, 59, "late"));
    expect(clearLogbookRange(dir, "2026-11-26", 12 * 60, 18 * 60)).toBe(2);
    expect(readLogbookDay(dir, "2026-11-26").map((e) => e.text)).toEqual(["morning"]);
    expect(clearLogbookRange(dir, "2026-11-26", 0, 24 * 60)).toBe(1);
    expect(existsSync(join(logbookDir(dir), "2026-11-26.jsonl"))).toBe(false);
  });

  it("names local days and offsets across a month end", () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(dayKeyOffset(new Date(2026, 11, 1, 8, 0), -1)).toBe("2026-11-30");
  });

  it("offers the query tool only while on or while notes are kept", () => {
    const dir = tempState();
    expect(logbookToolOffered(dir)).toBe(false);
    writeLogbookSettings(dir, { ...DEFAULT_LOGBOOK_SETTINGS, excludeApps: [], enabled: true });
    expect(logbookToolOffered(dir)).toBe(true);
    writeLogbookSettings(dir, { ...DEFAULT_LOGBOOK_SETTINGS, excludeApps: [], enabled: false });
    expect(logbookToolOffered(dir)).toBe(false);
    appendLogbookEntry(dir, entry(2026, 11, 26, 9, 0));
    expect(logbookToolOffered(dir)).toBe(true);
  });

  it("deletes chosen notes of a day by their time, and the file with the last one (ATO-2526)", () => {
    const dir = tempState();
    const a = entry(2026, 11, 26, 9, 0, "a");
    const b = entry(2026, 11, 26, 9, 5, "b");
    appendLogbookEntry(dir, a);
    appendLogbookEntry(dir, b);
    expect(deleteLogbookEntries(dir, "2026-11-26", [a.at, "2020-01-01T00:00:00.000Z"])).toBe(1);
    expect(readLogbookDay(dir, "2026-11-26").map((e) => e.text)).toEqual(["b"]);
    expect(deleteLogbookEntries(dir, "2026-11-26", [b.at])).toBe(1);
    expect(listLogbookDays(dir)).toEqual([]);
    expect(deleteLogbookEntries(dir, "2026-11-26", [b.at])).toBe(0);
  });
});
