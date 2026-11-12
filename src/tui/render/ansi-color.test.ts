import { describe, expect, it } from "vitest";
import {
  ansiForeground,
  detectAnsiColorDepth,
  rgbToAnsi256,
} from "./ansi-color.js";

describe("detectAnsiColorDepth", () => {
  it("trusts COLORTERM=truecolor / 24bit", () => {
    expect(detectAnsiColorDepth({ COLORTERM: "truecolor" })).toBe("truecolor");
    expect(detectAnsiColorDepth({ COLORTERM: "24bit" })).toBe("truecolor");
  });

  it("recognises terminals known to speak 24-bit colour", () => {
    expect(detectAnsiColorDepth({ TERM_PROGRAM: "iTerm.app" })).toBe(
      "truecolor",
    );
    expect(detectAnsiColorDepth({ WT_SESSION: "1" })).toBe("truecolor");
  });

  it("falls back to 256 colours when nothing confirms truecolor", () => {
    expect(detectAnsiColorDepth({})).toBe("256");
    expect(detectAnsiColorDepth({ TERM_PROGRAM: "Apple_Terminal" })).toBe(
      "256",
    );
  });
});

describe("rgbToAnsi256", () => {
  it("maps cube corners and greys to their xterm indices", () => {
    expect(rgbToAnsi256({ r: 255, g: 0, b: 0 })).toBe(196);
    expect(rgbToAnsi256({ r: 0, g: 0, b: 0 })).toBe(16);
    expect(rgbToAnsi256({ r: 255, g: 255, b: 255 })).toBe(231);
    expect(rgbToAnsi256({ r: 128, g: 128, b: 128 })).toBe(244);
  });
});

describe("ansiForeground", () => {
  it("emits a 24-bit SGR sequence in truecolor mode", () => {
    expect(ansiForeground("#569CD6", "truecolor")).toBe(
      "\u001b[38;2;86;156;214m",
    );
  });

  it("emits a 256-palette SGR sequence otherwise", () => {
    expect(ansiForeground("#ff0000", "256")).toBe("\u001b[38;5;196m");
  });

  it("drops an alpha channel and draws the colour opaque", () => {
    expect(ansiForeground("#ff000080", "truecolor")).toBe(
      "\u001b[38;2;255;0;0m",
    );
  });

  it("returns an empty string for a value it cannot parse", () => {
    expect(ansiForeground("not-a-colour", "truecolor")).toBe("");
  });
});
