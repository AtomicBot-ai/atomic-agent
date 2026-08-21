import { describe, expect, it } from "vitest";
import { formatHexColor, parseHexColor } from "./parse-hex-color.js";

describe("parseHexColor", () => {
  it("reads the six-digit form with and without the hash", () => {
    expect(parseHexColor("#4493f8")).toEqual({ r: 0x44, g: 0x93, b: 0xf8 });
    expect(parseHexColor("4493f8")).toEqual({ r: 0x44, g: 0x93, b: 0xf8 });
  });

  it("expands the three-digit form by doubling each nibble", () => {
    expect(parseHexColor("#abc")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
  });

  it("refuses anything it cannot read rather than guessing", () => {
    expect(parseHexColor("#abcd")).toBeNull();
    expect(parseHexColor("rebeccapurple")).toBeNull();
    expect(parseHexColor("")).toBeNull();
  });
});

describe("formatHexColor", () => {
  it("round-trips a parsed colour", () => {
    expect(formatHexColor(parseHexColor("#0969da")!)).toBe("#0969da");
  });

  it("pads a single-digit channel", () => {
    expect(formatHexColor({ r: 1, g: 2, b: 3 })).toBe("#010203");
  });

  it("clamps and rounds the fractional channels a mix produces", () => {
    expect(formatHexColor({ r: 12.6, g: -4, b: 300 })).toBe("#0d00ff");
  });
});
