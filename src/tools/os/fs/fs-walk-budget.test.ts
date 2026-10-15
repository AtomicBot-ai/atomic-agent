import { describe, it, expect } from "vitest";
import {
  createWalkBudget,
  DEFAULT_WALK_BUDGET,
  describeWalkStop,
} from "./fs-walk-budget.js";
import { OS_FS_GLOB_CONTRACT } from "./fs-glob-contract.js";

interface FakeClock {
  now: () => number;
  advance(ms: number): void;
}

function fakeClock(start = 1_000): FakeClock {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

describe("createWalkBudget", () => {
  it("carries on while under both limits", () => {
    const clock = fakeClock();
    const budget = createWalkBudget(
      { maxMs: 1_000, maxEntries: 10 },
      { now: clock.now },
    );
    clock.advance(999);
    expect(budget.check(9)).toBeNull();
  });

  it("stops on the time limit with the elapsed time and scan count", () => {
    const clock = fakeClock();
    const budget = createWalkBudget(
      { maxMs: 1_000, maxEntries: 10 },
      { now: clock.now },
    );
    clock.advance(1_500);
    expect(budget.check(4)).toEqual({
      reason: "time",
      elapsedMs: 1_500,
      scanned: 4,
    });
  });

  it("stops on the entry limit", () => {
    const budget = createWalkBudget(
      { maxMs: 1_000, maxEntries: 10 },
      { now: fakeClock().now },
    );
    expect(budget.check(10)?.reason).toBe("entries");
  });

  it("keeps returning the first stop once reached", () => {
    const clock = fakeClock();
    const budget = createWalkBudget(
      { maxMs: 1_000, maxEntries: 10 },
      { now: clock.now },
    );
    const first = budget.check(10);
    clock.advance(5_000);
    expect(budget.check(11)).toBe(first);
  });

  it("throws on an aborted signal instead of reporting a stop", () => {
    const controller = new AbortController();
    const budget = createWalkBudget(
      { maxMs: 1_000, maxEntries: 10 },
      { now: fakeClock().now, signal: controller.signal },
    );
    expect(budget.check(0)).toBeNull();
    controller.abort();
    expect(() => budget.check(1)).toThrow();
  });
});

describe("describeWalkStop", () => {
  it("names the limit, the numbers and what to do next", () => {
    const note = describeWalkStop({
      reason: "time",
      elapsedMs: 30_040,
      scanned: 123_456,
    });
    expect(note).toContain("partial results");
    expect(note).toContain("30 s");
    expect(note).toContain("123456 entries");
    expect(note).toContain("time limit");
    expect(note).toContain("Narrow the pattern or the root");
  });

  it("names the entry limit", () => {
    const note = describeWalkStop({
      reason: "entries",
      elapsedMs: 800,
      scanned: 200_000,
    });
    expect(note).toContain("entry limit");
    expect(note).toContain("0.8 s");
  });
});

describe("DEFAULT_WALK_BUDGET", () => {
  it("matches the numbers the glob contract quotes to the model", () => {
    const seconds = `${DEFAULT_WALK_BUDGET.maxMs / 1_000} s`;
    const entries = DEFAULT_WALK_BUDGET.maxEntries
      .toLocaleString("en-US")
      .replace(/,/g, " ");
    for (const text of [
      OS_FS_GLOB_CONTRACT.description,
      OS_FS_GLOB_CONTRACT.descriptor.summary,
    ]) {
      expect(text).toContain(seconds);
      expect(text).toContain(entries);
    }
  });
});
