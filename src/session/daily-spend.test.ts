import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DailySpendStore,
  dailySpendViewFor,
  effectiveDailyLimitUsd,
  isOverDailyLimit,
  spendDayKey,
} from "./daily-spend.js";

/**
 * ATO-649: today's spend over every session, kept on disk so it
 * survives a restart and is shared by the terminal and the desktop app.
 */
function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "daily-spend-")), "daily-spend.json");
}

const NOON = Date.UTC(2026, 10, 12, 12, 0);

describe("DailySpendStore", () => {
  it("starts at zero and adds priced calls only", () => {
    const store = new DailySpendStore({ path: tempPath(), now: () => NOON });
    expect(store.today()).toEqual({ day: "2026-11-12", usd: 0, pricedCalls: 0, unpricedCalls: 0 });
    store.record({ kind: "priced", usd: 0.4, source: "catalog" });
    store.record({ kind: "priced", usd: 0.1, source: "provider" });
    // Local, plan-billed and usage-less calls are not spend.
    store.record({ kind: "local" });
    store.record({ kind: "plan" });
    store.record({ kind: "none" });
    // An unknown price is counted as unpriced, never as $0.
    store.record({ kind: "unpriced" });
    const today = store.today();
    expect(today.usd).toBeCloseTo(0.5);
    expect(today.pricedCalls).toBe(2);
    expect(today.unpricedCalls).toBe(1);
  });

  it("survives a restart and adds to what another process wrote", () => {
    const path = tempPath();
    const terminal = new DailySpendStore({ path, now: () => NOON });
    const desktop = new DailySpendStore({ path, now: () => NOON });
    terminal.record({ kind: "priced", usd: 1, source: "provider" });
    desktop.record({ kind: "priced", usd: 2, source: "provider" });
    expect(new DailySpendStore({ path, now: () => NOON }).today().usd).toBeCloseTo(3);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ day: "2026-11-12", pricedCalls: 2 });
  });

  it("starts a new day at the reset hour", () => {
    const path = tempPath();
    let now = NOON;
    const store = new DailySpendStore({ path, now: () => now, resetHourUtc: () => 6 });
    store.record({ kind: "priced", usd: 3, source: "provider" });
    // 05:00 UTC the next day is still the same spend day with a 06:00 reset.
    now = Date.UTC(2026, 10, 13, 5, 0);
    expect(store.today().usd).toBeCloseTo(3);
    now = Date.UTC(2026, 10, 13, 6, 0);
    expect(store.today()).toMatchObject({ day: "2026-11-13", usd: 0 });
    expect(store.peek()).toMatchObject({ day: "2026-11-13", usd: 0 });
  });

  it("reads a damaged file as an empty day", () => {
    const path = tempPath();
    writeFileSync(path, "{not json");
    const store = new DailySpendStore({ path, now: () => NOON });
    expect(store.today().usd).toBe(0);
    store.record({ kind: "priced", usd: 0.2, source: "provider" });
    expect(store.today().usd).toBeCloseTo(0.2);
  });
});

describe("spendDayKey", () => {
  it("is the UTC day, shifted back before the reset hour", () => {
    expect(spendDayKey(Date.UTC(2026, 0, 1, 0, 30), 0)).toBe("2026-01-01");
    expect(spendDayKey(Date.UTC(2026, 0, 1, 0, 30), 3)).toBe("2025-12-31");
  });
});

describe("the ceiling", () => {
  it("is off unless it is a positive number", () => {
    expect(effectiveDailyLimitUsd(undefined)).toBeNull();
    expect(effectiveDailyLimitUsd(0)).toBeNull();
    expect(effectiveDailyLimitUsd(-1)).toBeNull();
    expect(effectiveDailyLimitUsd("5")).toBeNull();
    expect(effectiveDailyLimitUsd(5)).toBe(5);
  });

  it("is reached at the limit, not only past it", () => {
    const reading = { day: "2026-11-12", usd: 5, pricedCalls: 3, unpricedCalls: 0 };
    expect(isOverDailyLimit(reading, 5)).toBe(true);
    expect(isOverDailyLimit({ ...reading, usd: 4.99 }, 5)).toBe(false);
    expect(isOverDailyLimit(reading, null)).toBe(false);
  });
});

describe("dailySpendViewFor", () => {
  const store = { peek: () => ({ day: "2026-11-12", usd: 1.2, pricedCalls: 4, unpricedCalls: 0 }) };

  it("adds nothing to the readout unless the operator asked for it", () => {
    expect(dailySpendViewFor(store, undefined)).toBeUndefined();
    expect(dailySpendViewFor(store, { showInStatusBar: false })).toBeUndefined();
  });

  it("shows the day total when asked, and the ceiling when one is set", () => {
    expect(dailySpendViewFor(store, { showInStatusBar: true })).toEqual(store.peek());
    expect(dailySpendViewFor(store, { showInStatusBar: false, dailyLimitUsd: 5 })).toEqual({
      ...store.peek(),
      limitUsd: 5,
    });
  });
});
