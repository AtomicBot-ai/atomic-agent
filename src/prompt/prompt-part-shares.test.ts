import { describe, expect, it } from "vitest";

import { apportionParts, shareOut } from "./prompt-part-shares.js";

describe("shareOut", () => {
  it("adds up to the total exactly", () => {
    const shares = shareOut([3, 3, 3], 10);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10);
    expect(shares).toEqual([4, 3, 3]);
  });

  it("gives nothing when there is nothing to share", () => {
    expect(shareOut([0, 0], 50)).toEqual([0, 0]);
    expect(shareOut([5, 5], 0)).toEqual([0, 0]);
  });
});

describe("apportionParts (ATO-2453)", () => {
  it("prices a server's tools to its part, largest first", () => {
    const parts = apportionParts(
      [
        { label: "built-in tools", text: "x".repeat(360) },
        {
          label: "mcp github",
          mcpServer: "github",
          text: "y".repeat(720),
          tools: [
            { label: "small", text: "y".repeat(180) },
            { label: "big", text: "y".repeat(540) },
          ],
        },
      ],
      300,
    );
    const github = parts.find((p) => p.mcpServer === "github")!;
    expect(parts.reduce((a, p) => a + p.tokens, 0)).toBe(300);
    expect(github.tools?.map((t) => t.label)).toEqual(["big", "small"]);
    expect(github.tools?.reduce((a, t) => a + t.tokens, 0)).toBe(github.tokens);
    expect(parts.find((p) => p.label === "built-in tools")?.tools).toBeUndefined();
  });
});
