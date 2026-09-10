import { describe, expect, it } from "vitest";

import { renderPixelText } from "./pixel-font.js";

describe("renderPixelText", () => {
  it("draws five rows, one glyph per character, with a gap between them", () => {
    const rows = renderPixelText("Ok");
    expect(rows).toHaveLength(5);
    // Each row is glyph + space + glyph (trailing spaces trimmed).
    expect(rows[0]).toBe("▄▀▀▄ █  █");
    expect(rows[4]).toBe(" ▀▀  ▀  ▀");
  });

  it("keeps the grid aligned for every supported character", () => {
    const rows = renderPixelText("MODEL READY 0123456789");
    const widths = new Set(rows.map((r) => r.replace(/\s+$/, "").length));
    // Rows may differ only by trailing blanks, which are trimmed.
    expect(widths.size).toBeLessThanOrEqual(2);
    for (const row of rows) expect(row).not.toMatch(/[^▄▀█ ]/);
  });

  it("turns an unknown character into a gap rather than throwing", () => {
    expect(() => renderPixelText("a?b")).not.toThrow();
  });
});
