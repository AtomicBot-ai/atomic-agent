import { describe, expect, it } from "vitest";
import { getNoProgressStreak, getRepeatCount, RecentKeys, type HistoryEntry } from "./loop-history.js";

describe("RecentKeys", () => {
  it("counts a key only inside the window and never holds more than it", () => {
    const keys = new RecentKeys(3);
    expect(keys.push("a")).toBe(1);
    expect(keys.push("a")).toBe(2);
    keys.push("b");
    keys.push("c");
    expect(keys.push("a")).toBe(1);
    expect(keys.size).toBe(3);
    keys.clear();
    expect(keys.size).toBe(0);
  });
});

describe("history walks", () => {
  const entry = (resultHash: string, epoch?: number, polls?: number): HistoryEntry => ({
    tool: "os.shell.run",
    argsHash: "h",
    resultHash,
    ...(epoch !== undefined ? { epoch } : {}),
    ...(polls !== undefined ? { polls } : {}),
  });

  it("counts only entries of the same epochs", () => {
    const history = [entry("r", 0, 0), entry("r", 0, 0), entry("r", 1, 0), entry("r", 1, 1)];
    expect(getNoProgressStreak(history, "os.shell.run", "h", { epoch: 0, polls: 0 }).count).toBe(2);
    expect(getNoProgressStreak(history, "os.shell.run", "h", { epoch: 1, polls: 1 }).count).toBe(1);
    expect(getRepeatCount(history, "os.shell.run", "h", { epoch: 1, polls: 0 })).toBe(1);
  });

  it("matches entries without epochs to a call without epochs, as before", () => {
    const history = [entry("r"), entry("r"), entry("s")];
    expect(getNoProgressStreak(history, "os.shell.run", "h")).toEqual({ count: 1, latestResultHash: "s" });
    expect(getRepeatCount(history, "os.shell.run", "h")).toBe(3);
  });
});
