import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  INDICATOR_TTL_MS,
  indicatorState,
  LOGBOOK_INDICATOR_FILE,
  parseLogbookIndicator,
  readLogbookIndicator,
  writeLogbookIndicator,
} from "./logbook-indicator.js";

const T0 = 1_800_000_000_000;
const fresh = () => mkdtempSync(join(tmpdir(), "atomic-logbook-indicator-"));

describe("logbook indicator (ATO-2534)", () => {
  it("is visible to the process that received the report, until it expires", () => {
    const dir = fresh();
    writeLogbookIndicator(dir, { visible: true }, 4242, T0);
    const read = readLogbookIndicator(dir);
    expect(read).toEqual({ pid: 4242, visibleUntil: T0 + INDICATOR_TTL_MS, away: false });
    expect(indicatorState(read, 4242, T0 + 1_000)).toBe("visible");
    expect(indicatorState(read, 4242, T0 + INDICATOR_TTL_MS)).toBe("hidden");
  });

  it("never lets another process capture on a mark it did not receive", () => {
    const dir = fresh();
    writeLogbookIndicator(dir, { visible: true }, 4242, T0);
    expect(indicatorState(readLogbookIndicator(dir), 9999, T0 + 1_000)).toBe("hidden");
  });

  it("says away while the person is idle or the screen is locked", () => {
    const dir = fresh();
    writeLogbookIndicator(dir, { visible: true, away: true }, 4242, T0);
    expect(indicatorState(readLogbookIndicator(dir), 4242, T0)).toBe("away");
  });

  it("removes the report at once when the mark goes away", () => {
    const dir = fresh();
    writeLogbookIndicator(dir, { visible: true }, 4242, T0);
    expect(writeLogbookIndicator(dir, { visible: false }, 4242, T0 + 1)).toBeNull();
    expect(existsSync(join(dir, "logbook", LOGBOOK_INDICATOR_FILE))).toBe(false);
    expect(indicatorState(readLogbookIndicator(dir), 4242, T0 + 2)).toBe("hidden");
  });

  it("is hidden when there is no report or a broken one", () => {
    expect(indicatorState(readLogbookIndicator(fresh()), 1, T0)).toBe("hidden");
    expect(parseLogbookIndicator({ pid: "1", visibleUntil: T0 })).toBeNull();
    expect(parseLogbookIndicator({ pid: 1 })).toBeNull();
    expect(parseLogbookIndicator([])).toBeNull();
  });
});
