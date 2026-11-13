import { describe, expect, it } from "vitest";
import { rankMentionFiles } from "./rank-mention-files.js";

const files = ["src/tui/tui-app.tsx", "README.md", "src/app.ts", "docs/guide/app.md", "package.json"];

describe("rankMentionFiles", () => {
  it("lists the shallowest paths first for an empty query", () => {
    expect(rankMentionFiles("", files).slice(0, 2)).toEqual(["README.md", "package.json"]);
  });

  it("fuzzy-matches the query against the path", () => {
    const ranked = rankMentionFiles("srcapp", files);
    expect(ranked.slice(0, 2)).toContain("src/app.ts");
    expect(ranked).not.toContain("package.json");
  });

  it("caps the result count", () => {
    const many = Array.from({ length: 200 }, (_, i) => `f${i}.ts`);
    expect(rankMentionFiles("f", many, 10)).toHaveLength(10);
  });
});
