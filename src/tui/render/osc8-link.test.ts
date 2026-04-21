import { describe, expect, it } from "vitest";
import { OSC8_CONSTANTS, wrapOsc8 } from "./osc8-link.js";

describe("wrapOsc8", () => {
  it("wraps text in OSC 8 open/close escapes with the url", () => {
    const wrapped = wrapOsc8("cursor.com", "https://cursor.com");
    expect(wrapped).toBe(
      `${OSC8_CONSTANTS.open}https://cursor.com${OSC8_CONSTANTS.bel}cursor.com${OSC8_CONSTANTS.close}`,
    );
  });

  it("returns the raw text when url is empty", () => {
    expect(wrapOsc8("plain", "")).toBe("plain");
  });
});
