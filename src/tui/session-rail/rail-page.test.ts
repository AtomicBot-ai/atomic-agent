import { describe, expect, it } from "vitest";

import {
  RAIL_PAGE_SIZE,
  RAIL_TAIL_MARGIN,
  railTailInView,
} from "./rail-page.js";

describe("railTailInView", () => {
  it("is false while there is more than a margin of rows below the cursor", () => {
    expect(railTailInView(0, RAIL_PAGE_SIZE)).toBe(false);
    expect(
      railTailInView(RAIL_PAGE_SIZE - RAIL_TAIL_MARGIN - 1, RAIL_PAGE_SIZE),
    ).toBe(false);
  });

  it("is true from a margin's distance onwards", () => {
    expect(
      railTailInView(RAIL_PAGE_SIZE - RAIL_TAIL_MARGIN, RAIL_PAGE_SIZE),
    ).toBe(true);
    expect(railTailInView(RAIL_PAGE_SIZE - 1, RAIL_PAGE_SIZE)).toBe(true);
    // A cursor past the end (the list shrank under it) still counts.
    expect(railTailInView(RAIL_PAGE_SIZE + 3, RAIL_PAGE_SIZE)).toBe(true);
  });

  it("is false on an empty list", () => {
    // A fresh install has no rows to page past; every arrow key would
    // otherwise fire a store read that can only come back empty.
    expect(railTailInView(0, 0)).toBe(false);
  });

  it("is true anywhere in a list shorter than the margin", () => {
    // Nine stored threads: the whole list is inside the margin, so the
    // first ↓ asks for the next page and the store answers short once.
    expect(railTailInView(0, 9)).toBe(true);
  });

  it("keeps the page bigger than the rail and the picker can paint", () => {
    // Both surfaces window ten rows. A page that did not cover one
    // screenful would make ↓ a store read per keystroke.
    expect(RAIL_PAGE_SIZE).toBeGreaterThanOrEqual(10 + RAIL_TAIL_MARGIN);
  });
});
