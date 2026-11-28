import { describe, expect, it } from "vitest";

import type { UsageHistoryFile, UsageHistoryRow } from "./usage-history.js";
import {
  formatTokenCount,
  formatUsageHistory,
  shiftDay,
  summarizeUsageHistory,
} from "./usage-history-report.js";

/** ATO-2352: the per-day summary behind `atomic-agent usage`, checked against hand sums. */
function row(over: Partial<UsageHistoryRow>): UsageHistoryRow {
  return {
    billing: "cloud",
    providerId: "openrouter",
    model: "gpt-x",
    calls: 1,
    inputTokens: 1000,
    outputTokens: 100,
    cachedTokens: 0,
    usd: 0.1,
    pricedCalls: 1,
    unpricedCalls: 0,
    ...over,
  };
}

const HISTORY: UsageHistoryFile = {
  version: 1,
  days: {
    "2026-11-01": [row({ calls: 9, inputTokens: 9 })], // outside a 7-day window
    "2026-11-10": [
      row({ calls: 2, inputTokens: 2000, outputTokens: 200, cachedTokens: 500, usd: 0.3, pricedCalls: 2 }),
      row({ billing: "local", providerId: "local", model: "qwen3-8b", calls: 3, inputTokens: 6000, outputTokens: 1800, usd: 0, pricedCalls: 0 }),
    ],
    "2026-11-12": [row({ usd: 0, pricedCalls: 0, unpricedCalls: 1 })],
  },
};

describe("summarizeUsageHistory", () => {
  it("sums each day and the window, splitting local from cloud tokens", () => {
    const s = summarizeUsageHistory(HISTORY, { days: 7, today: "2026-11-12" });
    expect(s.from).toBe("2026-11-06");
    expect(s.days.map((d) => d.day)).toEqual(["2026-11-10", "2026-11-12"]);
    const nov10 = s.days[0];
    expect(nov10).toMatchObject({
      calls: 5,
      inputTokens: 8000,
      outputTokens: 2000,
      cachedTokens: 500,
      localTokens: 7800,
      cloudTokens: 2200,
      pricedCalls: 2,
    });
    expect(nov10?.usd).toBeCloseTo(0.3);
    // Biggest model first.
    expect(nov10?.models.map((m) => m.model)).toEqual(["qwen3-8b", "gpt-x"]);
    expect(s.total).toMatchObject({ calls: 6, inputTokens: 9000, outputTokens: 2100, unpricedCalls: 1 });
  });

  it("covers every stored day with all", () => {
    const s = summarizeUsageHistory(HISTORY, { days: "all", today: "2026-11-12" });
    expect(s.from).toBeNull();
    expect(s.days).toHaveLength(3);
  });

  it("one day means today only", () => {
    const s = summarizeUsageHistory(HISTORY, { days: 1, today: "2026-11-12" });
    expect(s.days.map((d) => d.day)).toEqual(["2026-11-12"]);
  });
});

describe("formatUsageHistory", () => {
  it("prints a line per day, the local share and the cost, plus a total", () => {
    const text = formatUsageHistory(summarizeUsageHistory(HISTORY, { days: 7, today: "2026-11-12" }));
    const lines = text.split("\n");
    expect(lines[0]).toBe("Token usage, 2026-11-06 to 2026-11-12");
    expect(lines[1]).toMatch(/^Day\s+Calls\s+Input\s+Output\s+Cached\s+Local\s+Cloud cost$/);
    expect(lines.find((l) => l.startsWith("2026-11-10"))).toMatch(/5\s+8\.0k\s+2\.0k\s+500\s+78%\s+\$0\.30$/);
    // Only an unpriced cloud call that day: the cost is unknown, not $0.
    expect(lines.find((l) => l.startsWith("2026-11-12"))).toMatch(/0%\s+n\/a$/);
    expect(lines.find((l) => l.startsWith("Total"))).toMatch(/\$0\.30\+$/);
    expect(text).not.toContain("qwen3-8b");
  });

  it("lists models under each day with --models", () => {
    const text = formatUsageHistory(summarizeUsageHistory(HISTORY, { days: 7, today: "2026-11-12" }), { models: true });
    expect(text).toMatch(/\n {2}local qwen3-8b\s+3\s+6\.0k\s+1\.8k/);
  });

  it("says so when nothing was recorded", () => {
    const text = formatUsageHistory(summarizeUsageHistory({ version: 1, days: {} }, { days: 7, today: "2026-11-12" }));
    expect(text).toContain("nothing recorded yet");
  });
});

describe("sessions per day (ATO-2442)", () => {
  const WITH_SESSIONS: UsageHistoryFile = {
    ...HISTORY,
    sessions: { "2026-11-10": ["aaa", "bbb"], "2026-11-12": ["bbb", "ccc"] },
  };

  it("counts each day's sessions and the distinct ones over the window; older days have none", () => {
    const s = summarizeUsageHistory(WITH_SESSIONS, { days: "all", today: "2026-11-12" });
    expect(s.days.map((d) => [d.day, d.sessions])).toEqual([
      ["2026-11-01", null],
      ["2026-11-10", 2],
      ["2026-11-12", 2],
    ]);
    expect(s.sessions).toBe(3);
    expect(summarizeUsageHistory(HISTORY, { days: 7, today: "2026-11-12" }).sessions).toBeNull();
  });

  it("prints a Sessions column only when asked, with - for a day before the count", () => {
    const summary = summarizeUsageHistory(WITH_SESSIONS, { days: "all", today: "2026-11-12" });
    expect(formatUsageHistory(summary).split("\n")[1]).not.toContain("Sessions");
    const lines = formatUsageHistory(summary, { sessions: true }).split("\n");
    expect(lines[1]).toMatch(/Cloud cost\s+Sessions$/);
    expect(lines.find((l) => l.startsWith("2026-11-01"))).toMatch(/\s-$/);
    expect(lines.find((l) => l.startsWith("2026-11-10"))).toMatch(/\s2$/);
    expect(lines.find((l) => l.startsWith("Total"))).toMatch(/\s3$/);
  });
});

describe("helpers", () => {
  it("shifts days across month and year ends", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-01-01", -6)).toBe("2025-12-26");
  });

  it("formats token counts", () => {
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(12_340)).toBe("12.3k");
    expect(formatTokenCount(4_500_000)).toBe("4.5M");
  });
});
