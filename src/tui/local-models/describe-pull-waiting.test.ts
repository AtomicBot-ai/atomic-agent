import { describe, expect, it } from "vitest";

import { describePullWaiting } from "./describe-pull-waiting.js";

describe("describePullWaiting", () => {
  const now = Date.parse("2026-09-08T18:30:00.000Z");

  it("says how long until the next attempt and why the last one died", () => {
    const line = describePullWaiting(
      { reason: "fetch failed", attempt: 4, nextRetryAt: "2026-09-08T18:30:32.000Z" },
      now,
    );
    expect(line).toBe(
      "⏸ waiting for the network — attempt 4, next try in 32s (fetch failed)",
    );
  });

  it("reads as retrying once the scheduled time has passed", () => {
    const line = describePullWaiting(
      { reason: "Download stalled: no data for 60s", attempt: 1, nextRetryAt: "2026-09-08T18:29:00.000Z" },
      now,
    );
    expect(line).toMatch(/attempt 1, retrying \(Download stalled/);
  });
});
