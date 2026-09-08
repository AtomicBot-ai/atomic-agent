import { describe, expect, it } from "vitest";

import { formatProviderOutage } from "./format-provider-outage.js";

describe("formatProviderOutage", () => {
  it("counts the wait against its budget while the turn is parked", () => {
    expect(
      formatProviderOutage({
        reason: "fetch failed",
        waitedMs: 14_000,
        maxWaitMs: 300_000,
        attempt: 3,
        givenUp: false,
      }),
    ).toBe("waiting for provider 14s/300s — fetch failed");
  });

  it("switches wording once the wait has run out", () => {
    // Different question for the operator: nothing to wait for any
    // more, so the line says the state of the link, not a countdown.
    expect(
      formatProviderOutage({
        reason: "fetch failed",
        waitedMs: 300_000,
        maxWaitMs: 300_000,
        attempt: 9,
        givenUp: true,
      }),
    ).toBe("provider unreachable — fetch failed");
  });

  it("keeps the line short enough for the meta bar", () => {
    // It shares a row with the route, the context readout and the mode
    // chip; a wrapped meta bar costs the composer a line.
    const line = formatProviderOutage({
      reason:
        "Can't reach \"aimlapi\" — no response from api.aimlapi.com after three attempts, check the provider URL or your connection",
      waitedMs: 4_000,
      maxWaitMs: 300_000,
      attempt: 2,
      givenUp: false,
    });
    expect(line.length).toBeLessThanOrEqual(80);
    expect(line.endsWith("…")).toBe(true);
  });

  it("flattens a multi-line reason", () => {
    expect(
      formatProviderOutage({
        reason: "socket hang up\n  at Socket.onClose",
        waitedMs: 0,
        maxWaitMs: 60_000,
        attempt: 1,
        givenUp: false,
      }),
    ).toBe("waiting for provider 0s/60s — socket hang up at Socket.onClose");
  });
});
