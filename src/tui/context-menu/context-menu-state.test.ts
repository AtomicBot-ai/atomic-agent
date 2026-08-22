import { describe, expect, it } from "vitest";
import {
  contextMenuItems,
  stripFieldPasteControls,
} from "./context-menu-state.js";

describe("contextMenuItems", () => {
  it("offers all three verbs on an editor with a selection", () => {
    expect(contextMenuItems({ kind: "editor", hasSelection: true })).toEqual([
      "cut",
      "copy",
      "paste",
    ]);
  });

  it("hides cut/copy on a caret-only editor", () => {
    expect(contextMenuItems({ kind: "editor", hasSelection: false })).toEqual([
      "paste",
    ]);
  });

  it("is paste-only on a hand-rolled field", () => {
    expect(contextMenuItems({ kind: "field" })).toEqual(["paste"]);
  });
});

describe("stripFieldPasteControls", () => {
  it("removes newlines and control bytes but keeps the text", () => {
    expect(stripFieldPasteControls("sk-abc\n")).toBe("sk-abc");
    expect(stripFieldPasteControls("a\r\nb\tcd")).toBe("abcd");
  });

  it("keeps non-ASCII printable text intact", () => {
    expect(stripFieldPasteControls("модель-α")).toBe("модель-α");
  });
});
