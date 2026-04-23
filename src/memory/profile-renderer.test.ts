import { describe, it, expect } from "vitest";

import { renderProfileSection } from "./profile-renderer.js";

describe("renderProfileSection", () => {
  it("returns the sentinel when empty", () => {
    expect(renderProfileSection([])).toBe("(no profile)");
  });

  it("emits facts sorted alphabetically by key", () => {
    const out = renderProfileSection([
      { key: "timezone", value: "UTC", updatedAt: 1 },
      { key: "language", value: "ru", updatedAt: 2 },
      { key: "name", value: "Alex", updatedAt: 3 },
    ]);
    expect(out).toBe(
      [
        "- language: ru",
        "- name: Alex",
        "- timezone: UTC",
      ].join("\n"),
    );
  });

  it("collapses multi-line values into single prompt lines", () => {
    const out = renderProfileSection([
      {
        key: "note",
        value: "first line\nsecond line\r\nthird",
        updatedAt: 1,
      },
    ]);
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain(" \\n ");
  });
});
