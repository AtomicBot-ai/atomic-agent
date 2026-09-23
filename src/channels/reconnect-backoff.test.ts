import { describe, expect, it } from "vitest";

import * as discordTransport from "./discord/discord-gateway-transport.js";
import { MAX_BACKOFF_MS, backoffMs } from "./reconnect-backoff.js";

describe("backoffMs", () => {
  it("doubles the ceiling per attempt until the 60 s cap", () => {
    const longest = (attempt: number): number => backoffMs(attempt, () => 1);
    expect([1, 2, 3, 4, 5, 6, 7, 30].map(longest)).toEqual([
      2_500, 4_500, 8_500, 16_500, 32_500, 60_500, 60_500, 60_500,
    ]);
  });

  it("never retries sooner than half a second", () => {
    expect(backoffMs(1, () => 0)).toBe(500);
    expect(backoffMs(30, () => 0)).toBe(500);
  });

  it("is the schedule the Discord gateway still imports from its transport", () => {
    // Moved here so the Telegram poller can share it; the Discord import
    // path and its behaviour must not change.
    expect(discordTransport.backoffMs).toBe(backoffMs);
    expect(discordTransport.MAX_BACKOFF_MS).toBe(MAX_BACKOFF_MS);
  });
});
