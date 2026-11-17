import { describe, expect, it } from "vitest";

import { diffLineTone, diffToneColor, looksLikeUnifiedDiff } from "./diff-line-tone.js";

const EDIT_DIFF = [
  "--- a//w/notes.md",
  "+++ b//w/notes.md",
  " # Notes",
  "-old line",
  "+new line",
  " tail",
].join("\n");

describe("diff-line-tone (ATO-563)", () => {
  it("recognises an os.fs.edit diff and a git-style hunk", () => {
    expect(looksLikeUnifiedDiff(EDIT_DIFF)).toBe(true);
    expect(looksLikeUnifiedDiff("@@ -1,2 +1,2 @@\n-a\n+b")).toBe(true);
    expect(looksLikeUnifiedDiff(EDIT_DIFF.replace(/\n/g, "\r\n"))).toBe(true);
  });

  it("leaves plain content alone, a Markdown list included", () => {
    expect(looksLikeUnifiedDiff("- milk\n- eggs\n+ bread")).toBe(false);
    expect(looksLikeUnifiedDiff("rm -rf ./build")).toBe(false);
    expect(looksLikeUnifiedDiff("--- a/x\n+++ b/x\n same")).toBe(false);
    expect(looksLikeUnifiedDiff("")).toBe(false);
  });

  it("gives each line its tone and colour", () => {
    expect(EDIT_DIFF.split("\n").map(diffLineTone)).toEqual(["file", "file", null, "del", "add", null]);
    expect(diffLineTone("@@ -3 +3 @@")).toBe("hunk");
    const colors = { success: "green", error: "red", muted: "gray" };
    expect(diffToneColor("add", colors)).toBe("green");
    expect(diffToneColor("del", colors)).toBe("red");
    expect(diffToneColor("hunk", colors)).toBe("gray");
    expect(diffToneColor(null, colors, "white")).toBe("white");
    expect(diffToneColor(null, colors)).toBeUndefined();
  });
});
