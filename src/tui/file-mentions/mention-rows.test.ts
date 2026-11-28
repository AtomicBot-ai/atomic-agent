import { describe, expect, it } from "vitest";
import { mentionRows } from "./mention-rows.js";

const files = ["README.md", "src/app.ts", "src/tui/view.tsx", "docs/guide.md"];
const folders = ["docs/", "src/", "src/tui/"];

describe("mentionRows (ATO-2472)", () => {
  it("puts the keywords a query starts above the files", () => {
    expect(mentionRows("d", files, folders)[0]).toBe("diff");
    expect(mentionRows("pro", files, folders)[0]).toBe("problems");
    expect(mentionRows("gi", files, folders)[0]).toBe("git:5");
  });

  it("offers folders next to files", () => {
    expect(mentionRows("src/tu", files, folders)).toContain("src/tui/");
    expect(mentionRows("", files, folders)).toEqual(expect.arrayContaining(["docs/", "src/", "README.md"]));
  });

  it("keeps a typed range or link as the first row", () => {
    expect(mentionRows("src/app.ts:10-20", files, folders)[0]).toBe("src/app.ts:10-20");
    expect(mentionRows("https://example.com/x", files, folders)[0]).toBe("https://example.com/x");
  });

  it("lists a row once even when it is both a keyword and a match", () => {
    const rows = mentionRows("src/", files, folders);
    expect(rows.filter((r) => r === "src/")).toHaveLength(1);
  });
});
