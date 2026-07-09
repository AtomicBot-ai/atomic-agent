import { describe, expect, it } from "vitest";
import { normalizeInsertText } from "./multi-line-editor-input.js";

describe("normalizeInsertText", () => {
  it("collapses CRLF into a single newline", () => {
    expect(normalizeInsertText("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("converts a lone CR into a newline", () => {
    expect(normalizeInsertText("a\rb\rc")).toBe("a\nb\nc");
  });

  it("does not leave any carriage return behind (the paste-tear cause)", () => {
    const out = normalizeInsertText("line1\r\nline2\rline3");
    expect(out.includes("\r")).toBe(false);
    expect(out).toBe("line1\nline2\nline3");
  });

  it("keeps tabs and newlines", () => {
    expect(normalizeInsertText("a\tb\nc")).toBe("a\tb\nc");
  });

  it("drops stray C0 control characters and DEL", () => {
    expect(normalizeInsertText("a\u0000b\u001bc\u0008d\u007fe")).toBe("abcde");
  });

  it("leaves plain unicode text untouched", () => {
    expect(normalizeInsertText("Нарежь индейку — вкусно 🙂")).toBe(
      "Нарежь индейку — вкусно 🙂",
    );
  });

  it("reduces control-only input to just the normalised newline", () => {
    expect(normalizeInsertText("\r\u0000\u001b")).toBe("\n");
  });

  it("returns an empty string when nothing survives", () => {
    expect(normalizeInsertText("\u0000\u001b\u0008")).toBe("");
  });
});
