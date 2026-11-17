import { describe, expect, it } from "vitest";

import { marketedRamGb } from "./host-ram.js";

const GIB = 1024 ** 3;

describe("marketedRamGb (ATO-1442)", () => {
  it("shows a 16 GB Mac as 16, not 17", () => {
    expect(marketedRamGb(16 * GIB)).toBe(16);
    expect(marketedRamGb(17_179_869_184)).toBe(16);
  });

  it("shows 18, 24 and 36 GB Macs as sold", () => {
    expect(marketedRamGb(18 * GIB)).toBe(18);
    expect(marketedRamGb(24 * GIB)).toBe(24);
    expect(marketedRamGb(36 * GIB)).toBe(36);
  });

  it("snaps a size just under a marketed one (reserved memory)", () => {
    expect(marketedRamGb(15.6 * GIB)).toBe(16);
  });

  it("keeps an odd machine's own rounded figure", () => {
    expect(marketedRamGb(20 * GIB)).toBe(20);
    expect(marketedRamGb(29.8 * GIB)).toBe(30);
  });

  it("never returns less than 1", () => {
    expect(marketedRamGb(0)).toBe(1);
    expect(marketedRamGb(Number.NaN)).toBe(1);
  });
});
