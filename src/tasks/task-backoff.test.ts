import { describe, it, expect } from "vitest";

import { nextDelayMs } from "./task-backoff.js";

describe("nextDelayMs", () => {
  it("returns initialMs on the first retry", () => {
    expect(nextDelayMs(1, { initialMs: 1_000, maxMs: 60_000 })).toBe(1_000);
  });

  it("doubles each subsequent attempt", () => {
    expect(nextDelayMs(2, { initialMs: 1_000, maxMs: 60_000 })).toBe(2_000);
    expect(nextDelayMs(3, { initialMs: 1_000, maxMs: 60_000 })).toBe(4_000);
    expect(nextDelayMs(4, { initialMs: 1_000, maxMs: 60_000 })).toBe(8_000);
  });

  it("clips to maxMs once the doubling crosses the cap", () => {
    expect(nextDelayMs(20, { initialMs: 1_000, maxMs: 60_000 })).toBe(60_000);
    expect(nextDelayMs(50, { initialMs: 1_000, maxMs: 60_000 })).toBe(60_000);
  });

  it("guards degenerate inputs", () => {
    expect(nextDelayMs(0, { initialMs: 1_000, maxMs: 60_000 })).toBe(0);
    expect(nextDelayMs(-1, { initialMs: 1_000, maxMs: 60_000 })).toBe(0);
    expect(nextDelayMs(3, { initialMs: 0, maxMs: 60_000 })).toBe(0);
    expect(nextDelayMs(3, { initialMs: 1_000, maxMs: 0 })).toBe(0);
  });
});
