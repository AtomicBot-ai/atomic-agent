import { describe, expect, it } from "vitest";

import { packIssue, renderSection } from "./issue-body.js";

describe("renderSection", () => {
  it("fences and collapses on request, escaping inner fences", () => {
    expect(renderSection({ title: "T", body: "plain" })).toBe("### T\n\nplain");
    const out = renderSection({ title: "L", body: "a\n```\nb", fenced: true, lang: "text", collapsed: true });
    expect(out.startsWith("<details>\n<summary>L</summary>")).toBe(true);
    expect(out).toContain("```text\na\n` ` `\nb\n```");
  });
});

describe("packIssue", () => {
  it("keeps everything in the body when it fits", () => {
    const packed = packIssue("head", [{ title: "A", body: "x" }, { title: "B", body: "y" }], { limit: 1000 });
    expect(packed.body).toBe("head\n\n### A\n\nx\n\n### B\n\ny");
    expect(packed.comments).toEqual([]);
    expect(packed.overflow).toEqual([]);
  });

  it("spills whole sections into comments, never splitting a fitting one", () => {
    const big = "z".repeat(60);
    const packed = packIssue("head", [
      { title: "A", body: big },
      { title: "B", body: big },
      { title: "C", body: big },
    ], { limit: 90 });
    expect(packed.body).toContain("### A");
    expect(packed.body).not.toContain("### B");
    expect(packed.comments).toHaveLength(2);
    expect(packed.comments[0]).toContain("### B");
    expect(packed.comments[1]).toContain("### C");
    for (const page of [packed.body, ...packed.comments]) {
      expect(page.length).toBeLessThanOrEqual(90);
    }
  });

  it("cuts a section that cannot fit even alone, keeping its tail", () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const packed = packIssue("h", [{ title: "Log", body, fenced: true, lang: "text" }], { limit: 400 });
    const page = packed.comments[0] ?? packed.body;
    expect(page.length).toBeLessThanOrEqual(400);
    expect(page).toContain("[cut");
    expect(page).toContain("line 199");
    expect(page).not.toContain("line 0\n");
  });

  it("stops at maxComments and names what stayed in the zip", () => {
    const big = "z".repeat(150);
    const packed = packIssue("head", [
      { title: "A", body: big },
      { title: "B", body: big },
      { title: "C", body: big },
      { title: "D", body: big },
    ], { limit: 300, maxComments: 1 });
    expect(packed.comments).toHaveLength(1);
    expect(packed.overflow).toEqual(["C", "D"]);
    expect(packed.comments[0]).toContain("Not included inline");
    expect(packed.comments[0]).toContain("C, D");
  });

  it("never cuts the header", () => {
    const header = "h".repeat(50);
    const packed = packIssue(header, [{ title: "A", body: "x".repeat(100) }], { limit: 60 });
    expect(packed.body).toBe(header);
    expect(packed.comments[0]).toContain("[cut");
  });
});
