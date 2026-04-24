import { describe, expect, it } from "vitest";
import { previewNextFirings } from "./cron-preview.js";

describe("previewNextFirings", () => {
  const now = Date.UTC(2026, 3, 24, 10, 0, 0);

  it("returns a single entry for at-schedules", () => {
    const target = now + 3_600_000;
    const firings = previewNextFirings({ kind: "at", at: target }, now);
    expect(firings).toEqual([target]);
  });

  it("advances interval schedules by everyMs and caps at count", () => {
    const firings = previewNextFirings(
      { kind: "interval", everyMs: 60_000 },
      now,
      4,
    );
    expect(firings).toEqual([
      now + 60_000,
      now + 120_000,
      now + 180_000,
      now + 240_000,
    ]);
  });

  it("peeks 5 cron firings by default", () => {
    const firings = previewNextFirings(
      { kind: "cron", expression: "0 * * * *" },
      now,
    );
    expect(firings).toHaveLength(5);
    for (let i = 1; i < firings.length; i += 1) {
      expect(firings[i]!).toBeGreaterThan(firings[i - 1]!);
    }
  });

  it("returns an empty list for invalid cron", () => {
    const firings = previewNextFirings(
      { kind: "cron", expression: "garbage" },
      now,
    );
    expect(firings).toEqual([]);
  });
});
