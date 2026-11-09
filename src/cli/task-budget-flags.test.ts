import { describe, expect, it } from "vitest";

import { parseDurationFlag, parseUsdFlag } from "./task-budget-flags.js";

describe("task budget flags", () => {
  it.each([
    ["5", 5],
    ["2.50", 2.5],
    ["$10", 10],
    [" .75 ", 0.75],
  ])("reads %j dollars", (raw, expected) => {
    expect(parseUsdFlag(raw)).toBe(expected);
  });

  it.each(["0", "0.00", "-1", "five", "5$", "1e3", ""])("refuses %j dollars", (raw) => {
    expect(parseUsdFlag(raw)).toBeNull();
  });

  it.each([
    ["90", 90_000],
    ["90s", 90_000],
    ["30m", 1_800_000],
    ["8h", 28_800_000],
    ["1h30m", 5_400_000],
    ["1.5h", 5_400_000],
    ["2d", 172_800_000],
    ["500ms", 500],
    ["8H", 28_800_000],
  ])("reads %j as a duration", (raw, expected) => {
    expect(parseDurationFlag(raw)).toBe(expected);
  });

  it.each(["", "0", "0s", "8 hours", "1h30", "h", "-5m", "5w"])("refuses %j as a duration", (raw) => {
    expect(parseDurationFlag(raw)).toBeNull();
  });
});
